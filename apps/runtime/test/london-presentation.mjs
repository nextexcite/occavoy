import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { canonicalJson } from "@occavoy/storage";
import { DeterministicEffectDispatcher } from "@occavoy/storage/effect-dispatcher";
import { FakeSupplierAdapter } from "@occavoy/storage/fake-supplier";
import { createCaseReturnHandler, fixtureSignInPage } from "../../web/src/server/case-return.tsx";

const CASE_PATH = "/cases/london-recovery";
const OPERATOR_PATH = "/operator/cases/london-recovery";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function label(kind, message) {
  console.log(`[london fixture][${kind}] ${message}`);
}

async function boundedPause(prompt, timeoutMs = 120_000) {
  if (!process.stdin.isTTY) {
    throw new Error("The London walkthrough requires an interactive terminal for scripted pauses.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const interrupted = new Promise((_, reject) => {
      rl.once("close", () =>
        reject(new Error("Walkthrough input closed before the bounded pause completed.")),
      );
      rl.once("SIGINT", () => reject(new Error("Walkthrough interrupted at a prompt.")));
    });
    await Promise.race([
      rl.question(prompt, { signal: AbortSignal.timeout(timeoutMs) }),
      interrupted,
    ]);
  } finally {
    rl.close();
  }
}

class RecordingSupplier {
  constructor(delegate, beforeSubmit = async () => {}) {
    this.delegate = delegate;
    this.beforeSubmit = beforeSubmit;
    this.lookupReferences = [];
  }

  get tenantId() {
    return this.delegate.tenantId;
  }

  get capabilities() {
    return this.delegate.capabilities;
  }

  async submitHandoff(request) {
    await this.beforeSubmit();
    return this.delegate.submitHandoff(request);
  }

  lookupByClientReference(clientReference) {
    this.lookupReferences.push(clientReference);
    return this.delegate.lookupByClientReference(clientReference);
  }

  fenceHandoffAttempt(target) {
    return this.delegate.fenceHandoffAttempt(target);
  }
}

function postedFormAction(html, labelText) {
  const formTags = [...html.matchAll(/<form\b[^>]*>/g)].map((match) => match[0]);
  const tag = formTags.find((candidate) => candidate.includes('method="post"'));
  assert.ok(tag, `${labelText} must render a POST form`);
  const action = tag.match(/action="([^"]+)"/)?.[1];
  assert.ok(action, `${labelText} POST form must render its action`);
  const start = html.indexOf(tag);
  const end = html.indexOf("</form>", start);
  assert.notEqual(end, -1, `${labelText} POST form must close`);
  return { tag, action, outer: html.slice(start, end) };
}

function makeBrowser(baseUrl) {
  let cookie = "";
  const headers = (extra = {}) => ({
    ...(cookie ? { cookie } : {}),
    ...extra,
  });
  return {
    cookie() {
      return cookie;
    },
    async login() {
      const loginPage = await fetch(`${baseUrl}/`, { redirect: "manual" });
      assert.equal(loginPage.status, 200);
      const loginHtml = await loginPage.text();
      const loginForm = postedFormAction(loginHtml, "fixture sign-in page");
      assert.equal(loginForm.action, "/session");
      assert.ok(
        !loginForm.outer.includes("<input"),
        "sign-in form must not accept a role or identity",
      );
      const response = await fetch(`${baseUrl}${loginForm.action}`, {
        method: "POST",
        headers: headers({
          origin: baseUrl,
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: "",
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), CASE_PATH);
      const setCookie = response.headers.get("set-cookie");
      assert.ok(setCookie?.includes("HttpOnly"));
      assert.ok(setCookie.includes("SameSite=Strict"));
      cookie = setCookie.split(";")[0];
      assert.ok(cookie.startsWith("occavoy_fixture_session="));
      const followed = await this.get(response.headers.get("location"));
      assert.equal(followed.status, 200);
      await followed.arrayBuffer();
      return cookie;
    },
    async get(path) {
      return fetch(`${baseUrl}${path}`, { headers: headers(), redirect: "manual" });
    },
    async post(path) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers({
          origin: baseUrl,
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: "",
        redirect: "manual",
      });
    },
  };
}

/**
 * London-only presentation fixture. The listener, customer session, operator
 * bearer and supplier are synthetic and owned by this test process.
 */
export async function presentLondon({ t, store, ledger, grant, walkthrough, registerCleanup }) {
  assert.ok(ledger, "the recovery fixture must provide its scoped usage ledger");
  const tenantId = grant.authority.tenantId;
  const caseId = grant.authority.caseId;
  assert.equal(caseId, "london-recovery");
  const customerAuthority = {
    tenantId,
    caseId,
    actorId: grant.relationship.customerId,
    grantId: "fixture-customer-viewer",
    permissions: ["proposal.approve"],
    validUntil: grant.deadline,
  };
  const operatorAuthority = {
    tenantId,
    caseId,
    actorId: "fixture-operator",
    grantId: "fixture-operator-viewer",
    permissions: ["action.reconcile"],
    validUntil: grant.deadline,
  };
  const operatorBearer = `Bearer ${randomUUID()}`;
  const sessions = new Set();
  let firstLoginCookie = "";
  let approveMutation = async () => {
    throw new Error("approval callback is not active yet");
  };
  let lookupMutation = async () => {
    throw new Error("lookup callback is not active yet");
  };

  const handleCase = createCaseReturnHandler({
    resolveViewer: async (request) => {
      if (request.headers.get("authorization") === operatorBearer) {
        return { role: "operator", authority: operatorAuthority };
      }
      const cookie = request.headers.get("cookie") ?? "";
      const session = cookie
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("occavoy_fixture_session="))
        ?.split("=", 2)[1];
      if (!session || !sessions.has(session)) return null;
      return { role: "customer", authority: customerAuthority };
    },
    store,
    approve: (input) => approveMutation(input),
    lookup: (input) => lookupMutation(input),
  });

  const server = createServer();
  const stylesPromise = readFile(new URL("../../web/src/styles.css", import.meta.url), "utf8");
  let baseUrl = "";
  server.on("request", async (req, res) => {
    try {
      const url = new URL(req.url, baseUrl);
      const expectedHost = new URL(baseUrl).host;
      if (req.headers.host !== expectedHost) {
        res.writeHead(404, { "cache-control": "no-store" }).end();
        return;
      }
      if (req.method === "POST" && req.headers.origin !== baseUrl) {
        res.writeHead(403, { "cache-control": "no-store" }).end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/styles.css") {
        res
          .writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/css; charset=utf-8",
          })
          .end(await stylesPromise);
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        const response = fixtureSignInPage();
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (req.method === "POST" && url.pathname === "/session") {
        const session = randomUUID();
        sessions.add(session);
        res
          .writeHead(303, {
            "cache-control": "no-store",
            location: CASE_PATH,
            "set-cookie": `occavoy_fixture_session=${session}; HttpOnly; Path=/; SameSite=Strict`,
          })
          .end();
        return;
      }
      if (!["GET", "HEAD", "POST"].includes(req.method)) {
        res.writeHead(405, { "cache-control": "no-store" }).end();
        return;
      }
      const request = new Request(new URL(req.url, baseUrl), {
        method: req.method,
        headers: req.headers,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req, duplex: "half" }),
      });
      const response = await handleCase(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "cache-control": "no-store" });
      res.end();
    }
  });
  let demoServerClosed = false;
  async function closeDemoServer() {
    if (demoServerClosed) return;
    demoServerClosed = true;
    sessions.clear();
    if (server.listening) {
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await closing;
    }
  }
  if (registerCleanup) registerCleanup(closeDemoServer);
  else t.after(closeDemoServer);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (walkthrough) {
    label("scripted input", `open only this loopback fixture URL: ${baseUrl}/`);
  }

  async function operatorPost(path) {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: operatorBearer,
        origin: baseUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "manual",
    });
  }

  async function operatorGet(path) {
    return fetch(`${baseUrl}${path}`, {
      headers: { authorization: operatorBearer },
      redirect: "manual",
    });
  }

  async function readCustomerPage(browser, labelText) {
    const before = await store.getCase(tenantId, caseId);
    const beforeTimeline = await store.getTimeline(tenantId, caseId);
    const response = await browser.get(CASE_PATH);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    const after = await store.getCase(tenantId, caseId);
    const afterTimeline = await store.getTimeline(tenantId, caseId);
    assert.equal(after.revision, before.revision);
    assert.equal(afterTimeline.length, beforeTimeline.length);
    for (const excluded of [
      customerAuthority.grantId,
      operatorAuthority.grantId,
      before.action?.clientReference,
      before.action?.requestHash,
      before.approval?.termsHash,
      before.action?.providerReference,
    ].filter(Boolean)) {
      assert.ok(!text.includes(excluded), `${labelText} leaked a raw internal identifier`);
    }
    label("actual HTTP/PG", `${labelText}: customer GET 200; revision ${after.revision} unchanged`);
    return text;
  }

  async function expectCustomerCheckpoint(browser, labelText, expected) {
    const text = await readCustomerPage(browser, labelText);
    assert.ok(
      text.includes(expected),
      `${labelText} customer page should include ${JSON.stringify(expected)}`,
    );
    return text;
  }

  async function checkSecurity(browser) {
    const unauthenticated = await makeBrowser(baseUrl).get(CASE_PATH);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("cache-control"), "no-store");
    assert.ok((await unauthenticated.text()).includes("Sign in to return to your saved request"));
    assert.equal((await browser.get("/cases/foreign-case")).status, 403);
    assert.equal((await browser.get(OPERATOR_PATH)).status, 403);
    assert.equal((await browser.post(`${OPERATOR_PATH}/lookup`)).status, 403);
    assert.equal((await operatorGet(CASE_PATH)).status, 403);
    assert.equal(
      (
        await fetch(`${baseUrl}/session`, {
          method: "POST",
          headers: {
            origin: "http://evil.example",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
          redirect: "manual",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/session`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "",
          redirect: "manual",
        })
      ).status,
      403,
    );
    label("actual HTTP", "401/403 and cross-origin POST checks passed without side effects");
  }

  async function pauseIfWalkthrough(prompt) {
    if (!walkthrough) return;
    await boundedPause(prompt);
  }

  async function submitCommercial(coordinator, body, actorId, permissions, commandId) {
    const current = await store.getCase(tenantId, caseId);
    const result = await coordinator.submit({
      command: {
        ...body,
        tenantId,
        caseId,
        expectedRevision: current.revision,
        commandId,
      },
      authority: {
        tenantId,
        caseId,
        actorId,
        grantId: `fixture-grant-${actorId}`,
        permissions,
        validUntil: grant.deadline,
      },
    });
    assert.equal(result.decision.outcome, "applied", result.decision.reason);
    return result.decision.state;
  }

  async function walkthroughApprovalPause() {
    if (!walkthrough) return;
    await pauseIfWalkthrough(
      `In the browser, use the fixture sign-in at ${baseUrl}/ if needed, open the saved request, review it, then click "Approve this exact offer". Press Enter here after the page shows approval. `,
    );
    const started = Date.now();
    while (!(await store.getCase(tenantId, caseId)).approval) {
      if (Date.now() - started > 120_000)
        throw new Error("Timed out waiting for browser approval.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function saved() {
    const browser = makeBrowser(baseUrl);
    const firstCookie = await browser.login();
    assert.notEqual(firstCookie, "");
    firstLoginCookie = firstCookie;
    const text = await expectCustomerCheckpoint(browser, "saved request", "Request saved");
    assert.ok(text.includes("A performance weekend in London"));
    assert.ok(text.includes("731.00 GBP"));
    assert.ok(text.includes("Europe/London"));
    assert.ok(text.includes("No action needed from you."));
    assert.ok(!text.includes("Approve this exact offer"));
    await checkSecurity(browser);
    await pauseIfWalkthrough(
      `Open ${baseUrl}/ in a browser, sign in as the fixture customer, and confirm the saved London request is visible. Press Enter to continue. `,
    );
    return { browser, cookie: firstCookie };
  }

  async function interrupted() {
    const browser = makeBrowser(baseUrl);
    const cookie = await browser.login();
    assert.notEqual(cookie, firstLoginCookie);
    const text = await expectCustomerCheckpoint(browser, "interrupted runtime", "Request saved");
    assert.ok(text.includes("A performance weekend in London"));
    assert.ok(text.includes("731.00 GBP"));
    assert.ok(text.includes("Europe/London"));
    assert.notEqual(cookie, "");
    const state = await store.getCase(tenantId, caseId);
    assert.equal(state.revision, 1);
    assert.equal(state.brief.version, 1);
    label(
      "actual HTTP/PG",
      "fresh login after runtime kill read the same activation and brief; no repost occurred",
    );
    await pauseIfWalkthrough(
      `Reopen or refresh ${baseUrl}/ in the browser and confirm the same saved request survives the runtime interruption. Press Enter to recover the runtime. `,
    );
  }

  async function continueFromRfq(coordinator) {
    const browser = makeBrowser(baseUrl);
    await browser.login();
    let state = await store.getCase(tenantId, caseId);
    assert.equal(state.scope.caseId, caseId);
    assert.equal(state.scope.customerId, grant.relationship.customerId);
    const accepted = state.requirements.find(
      (requirement) => requirement.category === "event_access",
    );
    assert.ok(accepted);
    assert.deepEqual(state.rfq.requirementIds, [accepted.id]);
    assert.equal(state.rfq.briefVersion, state.brief.version);
    const rfq = structuredClone(state.rfq);
    const awaitingQuote = await expectCustomerCheckpoint(
      browser,
      "awaiting supplier quote",
      "Awaiting quote",
    );
    assert.ok(awaitingQuote.includes("No action needed from you."));
    await pauseIfWalkthrough(
      "Refresh the saved case to see Awaiting quote. Press Enter to enter the synthetic event-access quote. ",
    );

    const supplierId = rfq.supplierId;
    const validUntil = new Date(Date.parse(grant.deadline) - 1_000).toISOString();
    const quote = {
      id: `quote-${rfq.id}`,
      version: 1,
      tenantId,
      caseId,
      rfqId: rfq.id,
      briefVersion: rfq.briefVersion,
      supplierId,
      sellerId: "fixture-event-access-seller",
      fulfillerId: "fixture-performance-access-fulfiller",
      payeeId: "fixture-event-access-payee",
      total: { amountMinor: 18_600, currency: "GBP" },
      validUntil,
      availability: "quoted",
      evidenceRef: "synthetic:london-event-access-quote",
    };
    state = await submitCommercial(
      coordinator,
      { kind: "record_quote", quote },
      "fixture-event-supplier-recorder",
      ["supply.record"],
      `london-record-quote-${rfq.id}`,
    );
    assert.deepEqual(state.quotes, [quote]);
    const unchecked = await expectCustomerCheckpoint(
      browser,
      "checked quote",
      "Quote being checked",
    );
    assert.ok(!unchecked.includes("186.00 GBP"));
    assert.ok(!unchecked.includes("/approve/"));

    const scope = { kind: "supplier_handoff", supplierId, lineIds: [quote.id] };
    const termsHash = sha256(
      canonicalJson({
        quoteId: quote.id,
        quoteVersion: quote.version,
        total: quote.total,
        validUntil: quote.validUntil,
        scope,
      }),
    );
    const proposal = {
      id: `proposal-${rfq.id}`,
      version: 1,
      tenantId,
      caseId,
      briefVersion: rfq.briefVersion,
      quoteId: quote.id,
      quoteVersion: quote.version,
      termsHash,
      total: structuredClone(quote.total),
      validUntil: quote.validUntil,
      approverActorId: state.brief.approverActorId,
      scope,
    };
    assert.equal(proposal.approverActorId, grant.relationship.customerId);
    state = await submitCommercial(
      coordinator,
      { kind: "stage_proposal", proposal },
      "fixture-proposal-writer",
      ["proposal.write"],
      `london-stage-proposal-${proposal.id}`,
    );
    state = await submitCommercial(
      coordinator,
      { kind: "publish_proposal" },
      "fixture-proposal-writer",
      ["proposal.write"],
      `london-publish-proposal-${proposal.id}-v${proposal.version}`,
    );
    assert.equal(state.phase, "awaiting_approval");
    const awaiting = await expectCustomerCheckpoint(
      browser,
      "awaiting payer approval",
      "Awaiting payer approval",
    );
    assert.ok(awaiting.includes("186.00 GBP"));
    assert.ok(awaiting.includes("Event access for this performance"));
    assert.ok(awaiting.includes("Review and approve the offer if you want to proceed."));
    assert.ok(!awaiting.includes(termsHash));

    const approvalForm = postedFormAction(awaiting, "customer approval page");
    const approvalAction = approvalForm.action;
    assert.equal(approvalAction, `${CASE_PATH}/approve/${state.revision}/${proposal.version}`);
    assert.ok(
      !approvalForm.outer.includes("<input"),
      "approval form must not accept business fields",
    );

    const revisionBeforeRejects = state.revision;
    assert.equal(
      (await browser.post(`${CASE_PATH}/approve/${state.revision}/${proposal.version + 1}`)).status,
      409,
    );
    assert.equal((await operatorPost(approvalAction)).status, 403);
    assert.equal((await store.getCase(tenantId, caseId)).revision, revisionBeforeRejects);
    assert.equal((await store.getCase(tenantId, caseId)).approval, null);
    label(
      "actual HTTP/PG",
      "stale/wrong-version and cross-role approval posts had no side effects",
    );

    const actionId = `action-${rfq.id}`;
    const clientReference = `client-reference-${rfq.id}`;
    const requestHash = sha256(
      canonicalJson({
        actionId,
        clientReference,
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        total: proposal.total,
        validUntil: proposal.validUntil,
        termsHash: proposal.termsHash,
        scope: proposal.scope,
      }),
    );
    const fakeSupplier = new FakeSupplierAdapter(
      tenantId,
      {
        supplierId,
        destinations: ["GB"],
        currencies: ["GBP"],
        supportsLookup: true,
        supportsIdempotency: false,
        supportsCancel: false,
      },
      "dropResponseAfterAccept",
    );
    const supplier = new RecordingSupplier(fakeSupplier, async () => {
      const drain = await coordinator.drain();
      assert.equal(drain.claimed, 0);
      const [handoff] = (await store.listOutboxForCase(tenantId, caseId)).filter(
        (row) => row.intentKind === "supplier_handoff",
      );
      assert.ok(handoff, "dispatch must commit its supplier handoff intent before supplier send");
      assert.equal(handoff.status, "pending");
      assert.equal(handoff.attempts, 0);
    });
    const dispatcherAuthority = {
      tenantId,
      caseId,
      actorId: "fixture-effect-dispatcher",
      grantId: "fixture-grant-effect-dispatcher",
      permissions: ["handoff.dispatch", "supply.record", "action.reconcile"],
      validUntil: grant.deadline,
    };
    const dispatchContext = { tenantId, caseId, actionId, authority: dispatcherAuthority };
    await assert.rejects(
      new DeterministicEffectDispatcher(store, supplier).dispatchApprovedHandoff({
        ...dispatchContext,
        clientReference,
        requestHash,
        now: new Date(),
      }),
      /approval_required/,
    );
    assert.equal(fakeSupplier.submitCalls, 0);
    assert.equal(fakeSupplier.orderCount, 0);
    label(
      "scripted check",
      "dispatcher rejected dispatch before payer approval; supplier not called",
    );

    approveMutation = async ({ approval, expectedRevision, viewer }) => {
      assert.ok(Number.isFinite(Date.parse(approval.approvedAt)));
      assert.deepEqual(
        { ...approval, approvedAt: "<server-clock>" },
        {
          id: `approval-${proposal.id}-v${proposal.version}`,
          tenantId,
          caseId,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          termsHash: proposal.termsHash,
          total: proposal.total,
          validUntil: proposal.validUntil,
          scope: proposal.scope,
          approvedBy: grant.relationship.customerId,
          authorityGrantId: customerAuthority.grantId,
          approvedAt: "<server-clock>",
        },
      );
      const result = await coordinator.submit({
        command: {
          kind: "approve_proposal",
          approval,
          tenantId,
          caseId,
          expectedRevision,
          commandId: `london-approve-${proposal.id}-v${proposal.version}`,
        },
        authority: viewer.authority,
      });
      if (result.decision.outcome === "applied") return { status: "applied" };
      if (
        ["stale_case_revision", "wrong_phase", "approval_expired_or_invalid"].includes(
          result.decision.reason,
        )
      ) {
        return { status: "stale" };
      }
      return { status: "rejected" };
    };

    if (walkthrough) {
      await walkthroughApprovalPause();
    } else {
      const approvedResponse = await browser.post(approvalAction);
      assert.equal(approvedResponse.status, 303);
      assert.equal(approvedResponse.headers.get("location"), CASE_PATH);
      const followedApproval = await browser.get(approvedResponse.headers.get("location"));
      assert.equal(followedApproval.status, 200);
      assert.ok((await followedApproval.text()).includes("Approved"));
    }
    const revisionAfterApproval = (await store.getCase(tenantId, caseId)).revision;
    assert.equal((await browser.post(approvalAction)).status, 409);
    assert.equal((await store.getCase(tenantId, caseId)).revision, revisionAfterApproval);
    assert.equal(fakeSupplier.submitCalls, 0);
    label("actual HTTP/PG", "replayed stale approval form returned 409 without side effects");
    state = await store.getCase(tenantId, caseId);
    assert.equal(state.phase, "fulfilling");
    assert.equal(state.action, null);
    assert.equal(state.approval.proposalId, proposal.id);
    assert.equal(state.approval.proposalVersion, proposal.version);
    assert.equal(state.approval.termsHash, proposal.termsHash);
    assert.deepEqual(state.approval.total, proposal.total);
    assert.deepEqual(state.approval.scope, proposal.scope);
    assert.equal(state.approval.validUntil, proposal.validUntil);
    assert.equal(state.approval.approvedBy, grant.relationship.customerId);
    assert.equal(state.approval.authorityGrantId, customerAuthority.grantId);
    assert.equal(fakeSupplier.submitCalls, 0);
    const approvedPage = await expectCustomerCheckpoint(
      browser,
      "approved before supplier handoff",
      "Approved",
    );
    assert.ok(approvedPage.includes("No action needed from you."));
    label(
      "actual HTTP/PG",
      "browser approval persisted the exact offer; no supplier submission yet",
    );

    await new DeterministicEffectDispatcher(store, supplier).dispatchApprovedHandoff({
      ...dispatchContext,
      clientReference,
      requestHash,
      now: new Date(),
    });
    state = await store.getCase(tenantId, caseId);
    assert.equal(state.action.status, "unknown");
    assert.equal(state.action.id, actionId);
    assert.equal(state.action.clientReference, clientReference);
    assert.equal(state.action.requestHash, requestHash);
    assert.equal(state.action.attempts, 1);
    assert.equal(state.waitReason, "reconciliation");
    assert.equal(state.booking, "pending");
    assert.equal(state.payment, "unobserved");
    assert.equal(state.fulfillment, "pending");
    assert.equal(fakeSupplier.submitCalls, 1);
    assert.equal(fakeSupplier.orderCount, 1);
    await expectCustomerCheckpoint(browser, "unknown supplier reply", "Supplier reply unavailable");
    await expectCustomerCheckpoint(browser, "unknown supplier reply detail", "no need to resubmit");

    await assert.rejects(
      new DeterministicEffectDispatcher(store, supplier).retryApprovedHandoff({
        ...dispatchContext,
        attempt: 1,
        now: new Date(),
      }),
      /reconciliation_required/,
    );
    assert.equal(fakeSupplier.submitCalls, 1);
    assert.equal(fakeSupplier.orderCount, 1);

    lookupMutation = async ({ actionId: requestedActionId, viewer }) => {
      assert.equal(requestedActionId, actionId);
      assert.equal(viewer.authority.actorId, operatorAuthority.actorId);
      await new DeterministicEffectDispatcher(store, supplier).reconcileUnknownAction({
        tenantId,
        caseId,
        actionId: requestedActionId,
        authority: viewer.authority,
        now: new Date(),
      });
      return { status: "applied" };
    };
    await pauseIfWalkthrough(
      "Refresh the customer tab to see the unavailable supplier reply. Press Enter here to perform the operator status lookup for the original supplier request. ",
    );
    const operatorUnknownPage = await operatorGet(OPERATOR_PATH);
    assert.equal(operatorUnknownPage.status, 200);
    const operatorUnknownHtml = await operatorUnknownPage.text();
    const lookupForm = postedFormAction(operatorUnknownHtml, "operator reconciliation page");
    assert.equal(lookupForm.action, `${OPERATOR_PATH}/lookup`);
    assert.ok(!/(dispatch|retry)/i.test(lookupForm.outer));
    assert.ok(!/action="[^"]*(dispatch|retry)/i.test(operatorUnknownHtml));
    const lookupResponse = await operatorPost(lookupForm.action);
    assert.equal(lookupResponse.status, 303);
    assert.equal(lookupResponse.headers.get("location"), OPERATOR_PATH);
    const followedLookup = await operatorGet(lookupResponse.headers.get("location"));
    assert.equal(followedLookup.status, 200);
    assert.ok((await followedLookup.text()).includes("confirmed"));
    assert.deepEqual(supplier.lookupReferences, [clientReference]);
    state = await store.getCase(tenantId, caseId);
    assert.equal(state.action.status, "confirmed");
    assert.equal(state.action.id, actionId);
    assert.equal(state.action.clientReference, clientReference);
    assert.equal(state.action.requestHash, requestHash);
    assert.equal(state.booking, "confirmed");
    assert.equal(state.payment, "unobserved");
    assert.equal(state.fulfillment, "pending");
    assert.equal(fakeSupplier.submitCalls, 1);
    assert.equal(fakeSupplier.orderCount, 1);
    assert.deepEqual(state.requirements, [accepted]);
    assert.deepEqual(state.rfq, rfq);
    assert.deepEqual(state.proposals.at(-1), proposal);
    assert.equal(state.scope.caseId, caseId);
    await expectCustomerCheckpoint(browser, "confirmed booking", "Booking confirmed");
    await expectCustomerCheckpoint(browser, "confirmed booking payment", "not yet observed");
    const operatorPage = await operatorGet(OPERATOR_PATH);
    assert.equal(operatorPage.status, 200);
    const operatorHtml = await operatorPage.text();
    assert.ok(operatorHtml.includes("confirmed"));
    assert.ok(!operatorHtml.includes("Retry"));
    assert.ok(!operatorHtml.includes("Dispatch"));

    const outbox = await store.listOutboxForCase(tenantId, caseId);
    assert.deepEqual(
      outbox.map((row) => [row.intentKind, row.status, row.attempts]),
      [
        ["run_agent_task", "completed", 2],
        ["request_supplier_quote", "completed", 1],
        ["supplier_handoff", "completed", 0],
      ],
    );
    const timeline = await store.getTimeline(tenantId, caseId);
    for (const [eventKind, count] of [
      ["command.record_quote", 1],
      ["command.stage_proposal", 1],
      ["command.publish_proposal", 1],
      ["command.approve_proposal", 1],
      ["command.dispatch_handoff", 1],
      ["command.handoff_unknown", 1],
      ["command.reconcile_handoff", 1],
    ]) {
      assert.equal(
        timeline.filter((event) => event.eventKind === eventKind).length,
        count,
        eventKind,
      );
    }
    const usage = await ledger.listUsage(tenantId, caseId);
    assert.deepEqual(
      usage.map((row) => row.kind),
      ["model_call", "tool_call", "tool_call", "model_call"],
    );
    await pauseIfWalkthrough(
      "Refresh the same case to see Booking confirmed, payment not observed and fulfilment pending. Press Enter to end the demo and remove its local data. ",
    );
    t.diagnostic(
      `london continuation: 1 quote / 1 proposal / 1 browser approval / ${fakeSupplier.submitCalls} supplier submit / ${fakeSupplier.orderCount} supplier order / ${supplier.lookupReferences.length} lookup; payment ${state.payment}, fulfillment ${state.fulfillment}`,
    );
  }

  return { saved, interrupted, continueFromRfq };
}
