/**
 * Shell for launched windows: `$SHELL`'s basename when set, else zsh. Launch sites
 * wrap claude in `<shell> -c '…; exec <shell> -l'` so the window keeps a usable
 * login shell after claude exits — that shell should be the user's own, not a
 * hardcoded zsh that may not exist on the host.
 */
export const USER_SHELL = process.env.SHELL?.split("/").pop() || "zsh";

/** Shell-quote a string for safe embedding in a compound shell command. */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
