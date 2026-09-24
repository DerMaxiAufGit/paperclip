// The login pseudo-terminal (PTY) transport. It gives an adapter device-login
// runner (the Codex and Grok device-auth flows) a child that runs on a real
// pseudo-terminal (PTY). The login command needs a PTY: pipe stdio emits no
// login prompt. The transport starts the command on a PTY, streams the
// incremental terminal output, and releases the session. The device-login flow
// needs no input: the user enters the displayed code in the browser.
//
// This module is provider-agnostic and pure. It holds no Node built-in import,
// so the browser-safe root entry can re-export it. A sandbox provider (for
// example the Daytona plugin) opens the concrete pseudo-terminal through a
// {@link LoginPtySessionOpener}. A unit test opens a fake pseudo-terminal
// through the same opener.
//
// Boundary (ANSI and OSC 8): the transport forwards the raw terminal bytes
// unchanged. It runs no ANSI or OSC 8 handling. The device-login prompt parser
// owns that handling, so the transport keeps every terminal byte intact for the
// parser.

/**
 * A live pseudo-terminal session for one device-login command. A sandbox
 * provider opens it. The session allocates a real pseudo-terminal, streams the
 * raw terminal output, and stops the child. The session forwards the raw
 * terminal bytes; it runs no ANSI or OSC 8 handling.
 */
export interface LoginPtySession {
  /**
   * Registers the one output listener. The session streams each raw terminal
   * output chunk to `listener`, in order, as the pseudo-terminal emits it.
   */
  onData(listener: (chunk: string) => void): void;
  /** Writes raw input bytes to the pseudo-terminal, unchanged. */
  write(data: string): void;
  /** Resolves with the child exit code when the command ends. */
  wait(): Promise<{ exitCode: number | null }>;
  /**
   * Stops the child process with a direct child stop (`SIGKILL`). The method
   * must be safe to call more than one time.
   */
  kill(): void;
  /** Releases the session resources. The method must be safe to call more than one time. */
  close(): Promise<void>;
}

/**
 * Opens a pseudo-terminal session for `command`. A provider binds this to its
 * sandbox. The transport calls it one time, on start.
 */
export type LoginPtySessionOpener = (command: string) => Promise<LoginPtySession>;

/**
 * The child side of a device-login run, in the shape the device-login driver
 * needs. The transport starts the command on a pseudo-terminal, streams the
 * terminal output, and releases the session.
 */
export interface LoginPtyTransport {
  /**
   * Opens the pseudo-terminal session for `command` and streams the terminal
   * output to `onData` in order. Resolves with the child exit code when the
   * command ends. The transport calls this one time.
   */
  start(command: string, onData: (chunk: string) => void): Promise<{ exitCode: number | null }>;
  /** Releases the transport resources. The method is safe to call more than one time. */
  dispose(): Promise<void>;
}

/**
 * Creates a {@link LoginPtyTransport} over `open`. The transport adapts a
 * pseudo-terminal session into the device-login driver shape. It forwards the
 * raw terminal bytes with no ANSI or OSC 8 handling.
 */
export function createLoginPtyTransport(
  open: LoginPtySessionOpener,
): LoginPtyTransport {
  let session: LoginPtySession | null = null;
  let started = false;

  return {
    async start(command, onData): Promise<{ exitCode: number | null }> {
      if (started) {
        throw new Error("login PTY transport already started.");
      }
      started = true;
      const opened = await open(command);
      session = opened;
      opened.onData(onData);
      return opened.wait();
    },
    async dispose(): Promise<void> {
      // Release only a session that opened. A run that ended before start opens
      // no session, so there is nothing to close.
      if (session) await session.close();
    },
  };
}
