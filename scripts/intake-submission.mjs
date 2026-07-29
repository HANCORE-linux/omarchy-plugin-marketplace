import { appendFile } from "node:fs/promises";
import { classifySubmission } from "./submission.mjs";

const labels = JSON.parse(process.env.ISSUE_LABELS || "[]");
const result = classifySubmission({
  title: process.env.ISSUE_TITLE,
  body: process.env.ISSUE_BODY,
  hasSubmissionLabel: labels.includes("submission"),
});

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `should_validate=${result.shouldValidate}\nshould_label=${result.shouldLabel}\n`,
  );
}

console.log(
  result.shouldValidate
    ? `Submission accepted for validation${result.shouldLabel ? " and automatic labeling" : ""}.`
    : "Issue does not match the plugin submission structure; skipping.",
);
