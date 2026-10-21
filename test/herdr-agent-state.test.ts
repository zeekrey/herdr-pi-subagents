import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const modulePath = "../extensions/herdr-agent-state.ts";
const managedEnvironment = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_PI_SUBAGENTS_IDLE_DEBOUNCE_MS",
  "PI_CODING_AGENT_DIR",
] as const;
const originalEnvironment = Object.fromEntries(managedEnvironment.map((name) => [name, process.env[name]]));

let server: Server | undefined;
let socketPath: string | undefined;
let agentDir: string | undefined;
let importCounter = 0;

beforeEach(async () => {
  // Keep a locally installed herdr integration from disabling the extension under test.
  agentDir = await mkdtemp(join(tmpdir(), "herdr-pi-subagents-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HERDR_PI_SUBAGENTS_IDLE_DEBOUNCE_MS = "0";
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
  if (socketPath) {
    await rm(socketPath, { force: true });
    socketPath = undefined;
  }
  if (agentDir) {
    await rm(agentDir, { recursive: true, force: true });
    agentDir = undefined;
  }
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

type Handler = (event: unknown, context: unknown) => unknown;

function importFresh() {
  importCounter += 1;
  return import(`${modulePath}?test=${importCounter}`);
}

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const eventHandlers = new Map<string, Handler>();
  return {
    handlers,
    eventHandlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      events: {
        on(event: string, handler: Handler) {
          eventHandlers.set(event, handler);
          return () => {};
        },
      },
    },
  };
}

async function startRecordingServer(name: string): Promise<unknown[]> {
  const recordingSocketPath = join(tmpdir(), `herdr-pi-subagents-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      requests.push(JSON.parse(input.slice(0, newline)));
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = recordingSocketPath;
  process.env.HERDR_PANE_ID = "test:p1";
  return requests;
}

function piContext(isIdle: () => boolean, notifications: unknown[] = []) {
  return {
    hasUI: true,
    mode: "tui",
    isIdle,
    ui: { notify: (...args: unknown[]) => notifications.push(args) },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
    },
  };
}

function requestStates(requests: unknown[]): unknown[] {
  return requests
    .filter((request) => isRecord(request) && request.method === "pane.report_agent")
    .map((request) => (isRecord(request) && isRecord(request.params) ? request.params.state : undefined));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await Bun.sleep(5);
  }
  expect(predicate()).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function startWorkingSession(name: string) {
  const requests = await startRecordingServer(name);
  const harness = createExtensionHarness();
  const { default: install } = await importFresh();
  install(harness.pi);

  const session = { idle: true };
  const context = piContext(() => session.idle);
  await harness.handlers.get("session_start")?.({ reason: "startup" }, context);
  await waitFor(() => requestStates(requests).length === 1);
  session.idle = false;
  harness.handlers.get("agent_start")?.({}, context);
  await waitFor(() => requestStates(requests).length === 2);
  expect(requestStates(requests)).toEqual(["idle", "working"]);
  return { requests, context, session, ...harness };
}

test("stays working while background subagents run after the parent settles", async () => {
  const { requests, context, session, handlers, eventHandlers } = await startWorkingSession("busy-settled");

  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent (worker)" }, context);
  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  await Bun.sleep(25);
  expect(requestStates(requests)).toEqual(["idle", "working"]);

  eventHandlers.get("herdr:busy")?.({ active: false }, context);
  await waitFor(() => requestStates(requests).length === 3);
  expect(requestStates(requests)).toEqual(["idle", "working", "idle"]);
});

test("busy label changes do not drop the pane to idle", async () => {
  const { requests, context, session, handlers, eventHandlers } = await startWorkingSession("busy-relabel");

  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent" }, context);
  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  // pi-subagents closes the previous raise before re-raising with a new label.
  eventHandlers.get("herdr:busy")?.({ active: false }, context);
  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 2 subagents" }, context);
  await Bun.sleep(25);
  expect(requestStates(requests)).toEqual(["idle", "working"]);
});

test("holds idle while the parent is woken after the last subagent finishes", async () => {
  process.env.HERDR_PI_SUBAGENTS_IDLE_DEBOUNCE_MS = "100";
  const { requests, context, session, handlers, eventHandlers } = await startWorkingSession("busy-handoff");

  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent" }, context);
  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  eventHandlers.get("herdr:busy")?.({ active: false }, context);
  await Bun.sleep(25);
  session.idle = false;
  handlers.get("agent_start")?.({}, context);
  await Bun.sleep(150);
  expect(requestStates(requests)).toEqual(["idle", "working"]);

  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  await waitFor(() => requestStates(requests).length === 3);
  expect(requestStates(requests)).toEqual(["idle", "working", "idle"]);
});

test("reports idle once the handoff window passes without a new turn", async () => {
  process.env.HERDR_PI_SUBAGENTS_IDLE_DEBOUNCE_MS = "50";
  const { requests, context, session, handlers, eventHandlers } = await startWorkingSession("busy-expired");

  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent" }, context);
  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  eventHandlers.get("herdr:busy")?.({ active: false }, context);
  await Bun.sleep(25);
  expect(requestStates(requests)).toEqual(["idle", "working"]);
  await waitFor(() => requestStates(requests).length === 3);
  expect(requestStates(requests)).toEqual(["idle", "working", "idle"]);
});

test("counts busy raised before the root session starts", async () => {
  const requests = await startRecordingServer("busy-reload");
  const { handlers, eventHandlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh();
  install(pi);

  const context = piContext(() => true);
  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent" }, context);
  await handlers.get("session_start")?.({ reason: "reload" }, context);
  await waitFor(() => requestStates(requests).length === 1);
  expect(requestStates(requests)).toEqual(["working"]);
});

test("blocked takes precedence over busy", async () => {
  const { requests, context, session, handlers, eventHandlers } = await startWorkingSession("busy-blocked");

  eventHandlers.get("herdr:busy")?.({ active: true, label: "⏳ 1 subagent" }, context);
  eventHandlers.get("herdr:blocked")?.({ active: true, label: "approval" }, context);
  await waitFor(() => requestStates(requests).length === 3);
  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  eventHandlers.get("herdr:blocked")?.({ active: false }, context);
  await waitFor(() => requestStates(requests).length === 4);
  expect(requestStates(requests)).toEqual(["idle", "working", "blocked", "working"]);
});

test("still reports idle after the parent settles without subagents", async () => {
  const { requests, context, session, handlers } = await startWorkingSession("no-busy");

  session.idle = true;
  handlers.get("agent_settled")?.({}, context);
  await waitFor(() => requestStates(requests).length === 3);
  expect(requestStates(requests)).toEqual(["idle", "working", "idle"]);
});

test("stands down when herdr's own Pi integration is installed", async () => {
  await mkdir(join(agentDir!, "extensions"), { recursive: true });
  await writeFile(join(agentDir!, "extensions", "herdr-agent-state.ts"), "// HERDR_INTEGRATION_ID=pi\n");
  const requests = await startRecordingServer("conflict");
  const { handlers, eventHandlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh();
  install(pi);

  const notifications: unknown[] = [];
  const context = piContext(() => false, notifications);
  await handlers.get("session_start")?.({ reason: "startup" }, context);
  handlers.get("agent_start")?.({}, context);
  await Bun.sleep(25);

  expect(eventHandlers.size).toBe(0);
  expect(requests).toEqual([]);
  expect(notifications).toHaveLength(1);
  expect(String((notifications[0] as unknown[])[0])).toContain("herdr integration uninstall pi");
});
