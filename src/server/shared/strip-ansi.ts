/** Strip ANSI escape codes and terminal control sequences from text. */
export function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- stripping ANSI/terminal sequences requires matching control chars */
  return text.replace(
    /\x1b(?:\[[0-9;<>?]*[a-zA-Z@`~]|\][^\x07]*\x07|[()#][A-Z0-9]|[>=<])/g,
    "",
  );
  /* eslint-enable no-control-regex */
}
