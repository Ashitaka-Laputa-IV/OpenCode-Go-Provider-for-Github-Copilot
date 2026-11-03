/**
 * Incremental Server-Sent Events parser. Feed it decoded text chunks and it
 * returns the `data` payloads of every complete event.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }

      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.consumeLine(line, events);
    }

    return events;
  }

  end(): string[] {
    const events: string[] = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.consumeLine(line, events);
    }
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    if (line.length === 0) {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "data") {
      this.dataLines.push(value);
    }
  }

  private dispatch(events: string[]): void {
    if (this.dataLines.length === 0) {
      return;
    }
    events.push(this.dataLines.join("\n"));
    this.dataLines = [];
  }
}
