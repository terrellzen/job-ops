import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchApi: vi.fn() }));
vi.mock("@/client/api/core", () => ({ fetchApi: mocks.fetchApi }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { EmailKeywordFilters } from "./EmailKeywordFilters";

beforeEach(() => {
  mocks.fetchApi.mockReset();
});
afterEach(cleanup);

describe("email keyword controls", () => {
  it("lets users review AI language suggestions and explicitly save them", async () => {
    const defaults = {
      enabled: true,
      languages: ["en", "de"],
      customKeywords: [],
    };
    mocks.fetchApi.mockImplementation(async (path, options) => {
      if (path.endsWith("/suggest"))
        return { keywords: ["candidature", "entretien"] };
      if (options?.method === "PATCH") return JSON.parse(options.body);
      return defaults;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <EmailKeywordFilters />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("English")).toBeEnabled());
    fireEvent.click(screen.getByText("Suggest keywords with AI"));
    fireEvent.change(screen.getByLabelText("Language"), {
      target: { value: "French" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Suggest keywords" }));
    await screen.findByText("candidature, entretien");
    expect(
      mocks.fetchApi.mock.calls.filter(
        ([, options]) => options?.method === "PATCH",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Add to custom keywords" }),
    );
    expect(screen.getByLabelText("Custom keywords")).toHaveValue(
      "candidature\nentretien",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save filters" }));
    await waitFor(() =>
      expect(mocks.fetchApi).toHaveBeenCalledWith(
        "/post-application/email-keywords",
        {
          method: "PATCH",
          body: JSON.stringify({
            ...defaults,
            customKeywords: ["candidature", "entretien"],
          }),
        },
      ),
    );
    client.clear();
  });
});
