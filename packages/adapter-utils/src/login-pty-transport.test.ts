import { describe, expect, it } from "vitest";
import {
  createLoginPtyTransport,
  type LoginPtySession,
} from "./login-pty-transport.js";

// A fixed device-login command. The transport never inspects the command; the
// sandbox provider maps it to the pseudo-terminal it opens.
const DEVICE_LOGIN_COMMAND = "codex login --device-auth";

/**
 * A fake pseudo-terminal session. It drives the output stream on demand and
 * records the close. The tests use it in place of a real pseudo-terminal, so the
 * transport runs with no sandbox.
 */
function createFakePtySession(): LoginPtySession & {
  emit: (chunk: string) => void;
  finish: (exitCode: number | null) => void;
  closed: number;
  // Resolves when the transport registers the output listener. The session
  // streams only after it opens, so a test waits on this before it drives the
  // output.
  ready: Promise<void>;
} {
  let listener: ((chunk: string) => void) | null = null;
  let resolveWait: ((value: { exitCode: number | null }) => void) | null = null;
  const waitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveWait = resolve;
  });
  let markReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let closed = 0;
  return {
    ready,
    onData(next: (chunk: string) => void): void {
      listener = next;
      markReady?.();
    },
    write(): void {},
    wait(): Promise<{ exitCode: number | null }> {
      return waitPromise;
    },
    kill(): void {},
    async close(): Promise<void> {
      closed += 1;
    },
    // Test control below. The transport never reads these fields.
    emit(chunk: string): void {
      listener?.(chunk);
    },
    finish(exitCode: number | null): void {
      resolveWait?.({ exitCode });
    },
    get closed(): number {
      return closed;
    },
  };
}

describe("createLoginPtyTransport", () => {
  it("opens the session for the given command", async () => {
    const session = createFakePtySession();
    const opened: string[] = [];
    const transport = createLoginPtyTransport(async (command) => {
      opened.push(command);
      return session;
    });

    const started = transport.start(DEVICE_LOGIN_COMMAND, () => {});
    session.finish(0);
    await started;

    expect(opened).toEqual([DEVICE_LOGIN_COMMAND]);
  });

  it("returns incremental terminal output to the runner", async () => {
    const session = createFakePtySession();
    const received: string[] = [];
    const transport = createLoginPtyTransport(async () => session);

    const started = transport.start(DEVICE_LOGIN_COMMAND, (chunk) => {
      received.push(chunk);
    });
    await session.ready;

    // Each output chunk reaches the runner as the pseudo-terminal emits it, not
    // as one final batch at the end.
    session.emit("first ");
    expect(received).toEqual(["first "]);
    session.emit("second");
    expect(received).toEqual(["first ", "second"]);

    session.finish(0);
    await started;
  });

  it("resolves start with the child exit code", async () => {
    const session = createFakePtySession();
    const transport = createLoginPtyTransport(async () => session);

    const started = transport.start(DEVICE_LOGIN_COMMAND, () => {});
    session.finish(7);

    await expect(started).resolves.toEqual({ exitCode: 7 });
  });

  it("refuses a second start", async () => {
    const session = createFakePtySession();
    const transport = createLoginPtyTransport(async () => session);

    const started = transport.start(DEVICE_LOGIN_COMMAND, () => {});
    await expect(transport.start(DEVICE_LOGIN_COMMAND, () => {})).rejects.toThrow(/already started/);
    session.finish(0);
    await started;
  });

  it("disposes the session resources", async () => {
    const session = createFakePtySession();
    const transport = createLoginPtyTransport(async () => session);

    const started = transport.start(DEVICE_LOGIN_COMMAND, () => {});
    session.finish(0);
    await started;

    await transport.dispose();
    expect(session.closed).toBe(1);
  });

  it("stays safe when dispose runs before start", async () => {
    const session = createFakePtySession();
    const transport = createLoginPtyTransport(async () => session);

    // The runner may dispose before it starts the child. The transport must not
    // throw, and it must not close a session it never opened.
    await transport.dispose();

    expect(session.closed).toBe(0);
  });
});
