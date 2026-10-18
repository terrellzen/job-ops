import { db, schema } from "@server/db";
import {
  createApplicationAttempt,
  listApplicationAttempts,
} from "@server/repositories/application-attempts";
import { transitionStage } from "@server/services/applicationTracking";
import { privateDataScopeFilter } from "@server/tenancy/private-scope";
import { and, eq } from "drizzle-orm";

export function startNewApplicationAttempt(
  jobId: string,
  input: {
    appliedAt: number;
    applicationReference?: string;
    requisitionId?: string;
  },
) {
  return db.transaction(() => {
    const attempt = createApplicationAttempt(jobId, input);
    db.update(schema.jobs)
      .set({
        outcome: null,
        closedAt: null,
        appliedAt: new Date(input.appliedAt).toISOString(),
      })
      .where(
        and(privateDataScopeFilter(schema.jobs), eq(schema.jobs.id, jobId)),
      )
      .run();
    transitionStage(jobId, "applied", Math.floor(input.appliedAt / 1000), {
      actor: "user",
      eventType: "status_update",
      eventLabel: `Application attempt ${attempt.sequence} started`,
    });
    return listApplicationAttempts(jobId);
  });
}
