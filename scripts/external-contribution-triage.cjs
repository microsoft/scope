// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const { createHash } = require("node:crypto");

const WORKFLOW_ID = "external-contribution-triage";
const MARKER = `<!-- gh-aw-workflow-id: ${WORKFLOW_ID} -->`;
const ASSOCIATIONS = new Set(["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR"]);
const ALLOWED_LABELS = [
  "type: bug", "type: enhancement", "type: documentation", "type: question",
  "area: api", "area: cicd", "area: cli", "area: gateway", "area: infrastructure",
  "area: judge", "area: portal", "area: post-processing", "area: reporting",
  "area: scheduler", "area: shared", "area: skills", "area: website", "area: worker",
];

function eligible(issue, pull) {
  return issue.state === "open" && issue.user?.type === "User" &&
    ASSOCIATIONS.has(issue.author_association) && (!pull || !pull.draft && pull.state === "open");
}

function fingerprint(issue, pull) {
  return createHash("sha256").update(JSON.stringify([
    issue.title, issue.body ?? "", pull?.head.sha ?? null,
  ])).digest("hex");
}

function ownComment(comment) {
  return comment.user?.type === "Bot" && comment.user.login === "github-actions[bot]" &&
    comment.body?.includes(MARKER);
}

function completed(comments, revision) {
  return comments.some((comment) => ownComment(comment) &&
    comment.body.includes(`<!-- scope-triage-revision: ${revision} -->`));
}

async function load(github, repo, number) {
  const { data: issue } = await github.rest.issues.get({ ...repo, issue_number: number });
  const pull = issue.pull_request
    ? (await github.rest.pulls.get({ ...repo, pull_number: number })).data
    : undefined;
  return { issue, pull };
}

async function commentsFor(github, repo, number) {
  return github.paginate(github.rest.issues.listComments, {
    ...repo, issue_number: number, per_page: 100,
  });
}

async function select({ github, context, core }) {
  core.setOutput("selected", "false");
  let numbers;
  if (context.eventName === "workflow_dispatch") {
    const raw = context.payload.inputs?.item_number;
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new Error("item_number must be a positive safe integer");
    }
    numbers = [Number(raw)];
  } else {
    // Bound discovery cost; move through older contributions as they are triaged.
    numbers = [];
    for (let page = 1; page <= 3; page++) {
      const { data } = await github.rest.issues.listForRepo({
        ...context.repo, state: "open", sort: "created", direction: "asc", per_page: 100, page,
      });
      numbers.push(...data.filter((issue) => eligible(issue)).map((issue) => issue.number));
      if (data.length < 100) break;
    }
  }
  for (const number of numbers) {
    const { issue, pull } = await load(github, context.repo, number);
    if (!eligible(issue, pull)) {
      core.notice(`Skipping #${number}: not an open, non-draft community contribution.`);
      continue;
    }
    const revision = fingerprint(issue, pull);
    if (completed(await commentsFor(github, context.repo, number), revision)) {
      core.notice(`Skipping #${number}: this revision has already been triaged.`);
      continue;
    }
    core.setOutput("item_number", String(number));
    core.setOutput("revision", revision);
    core.setOutput("selected", "true");
    return { number, revision };
  }
  core.notice("No eligible untriaged contribution in the discovery window.");
}

function validateProposal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["type", "body", "labels"].includes(key)) ||
      value.type !== "publish_triage" || typeof value.body !== "string" ||
      value.body.trim().length < 20 || value.body.length > 4000 ||
      typeof value.labels !== "string") {
    throw new Error("Expected one publish_triage proposal with a 20-4000 character body and JSON labels.");
  }
  if (/<|!\[|@[\w-]+|https?:\/\/(?!github\.com\/microsoft\/scope(?:\/|[)\s]|$))/i.test(value.body)) {
    throw new Error("Triage comments cannot contain hidden markers, images, mentions, or off-repository URLs.");
  }
  const labels = JSON.parse(value.labels);
  if (!Array.isArray(labels) || labels.length > 5 ||
      labels.some((label) => typeof label !== "string" || !ALLOWED_LABELS.includes(label)) ||
      new Set(labels).size !== labels.length ||
      labels.filter((label) => label.startsWith("type: ")).length > 1) {
    throw new Error("Labels must be a unique allowlisted array with at most five labels and one type.");
  }
  return { body: value.body.trim(), labels };
}

async function publish({ github, context, core, output, number, revision, staged }) {
  if (context.repo.owner !== "microsoft" || context.repo.repo !== "scope" || typeof staged !== "boolean") {
    throw new Error("Publisher requires microsoft/scope and an explicit preview decision");
  }
  if (!Number.isSafeInteger(number) || number <= 0 || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new Error("Missing trusted selection outputs");
  }
  if (!output || !Array.isArray(output.items)) throw new Error("Missing agent output items");
  const proposals = output.items.filter((item) => item.type === "publish_triage");
  if (proposals.length !== 1) throw new Error("Exactly one publish_triage proposal is required");
  const proposal = validateProposal(proposals[0]);
  const { issue, pull } = await load(github, context.repo, number);
  if (!eligible(issue, pull) || fingerprint(issue, pull) !== revision) {
    core.notice(`Skipping #${number}: contribution changed or became ineligible during analysis.`);
    return;
  }
  const comments = await commentsFor(github, context.repo, number);
  if (completed(comments, revision)) {
    core.notice(`Skipping #${number}: another run already triaged this revision.`);
    return;
  }
  const existing = issue.labels.map((label) => typeof label === "string" ? label : label.name);
  const labels = proposal.labels.filter((label) =>
    !existing.includes(label) &&
    !existing.some((current) => current?.startsWith(label.split(":")[0] + ": ")));
  const available = await github.paginate(github.rest.issues.listLabelsForRepo, { ...context.repo, per_page: 100 });
  for (const label of labels) {
    if (!available.some((entry) => entry.name === label)) throw new Error(`Repository label does not exist: ${label}`);
  }
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const body = `**Automated contribution triage** — advisory; maintainers make final decisions.\n\n${proposal.body}\n\n` +
    `[Workflow run](${runUrl})\n${MARKER}\n<!-- scope-triage-revision: ${revision} -->`;
  if (staged) {
    // Render text rather than agent-supplied HTML in the Actions summary.
    const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    await core.summary.addHeading(`Triage preview: #${number}`)
      .addRaw(`<pre>${escape(body)}</pre>`)
      .addRaw(`<p>Labels to add: ${escape(labels.join(", ") || "(none)")}</p>`)
      .addRaw("<p>No GitHub resources were changed.</p>").write();
    return;
  }
  const target = { ...context.repo, issue_number: number };
  if (labels.length) await github.rest.issues.addLabels({ ...target, labels });
  const previous = comments.filter(ownComment).at(-1);
  if (previous) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: previous.id, body });
  } else {
    // Do not retry comment creation: an ambiguous response could create duplicates.
    await github.rest.issues.createComment({ ...target, body, request: { retries: 0 } });
  }
  core.notice(`Triaged #${number}; added ${labels.length} labels.`);
}

module.exports = { ALLOWED_LABELS, MARKER, eligible, fingerprint, ownComment, completed, select, validateProposal, publish };
