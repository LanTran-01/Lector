/**
 * WebKit (macOS WKWebView / Safari) lacks async iteration over ReadableStream
 * (`for await (const chunk of stream)`). The eSpeak phonemizer used by Kokoro
 * relies on it to unpack its dictionary, and silently hangs without it.
 * This module must be imported before kokoro-js.
 */
type Iterable = ReadableStream & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

const proto = ReadableStream.prototype as Iterable;
if (typeof proto[Symbol.asyncIterator] !== "function") {
  proto[Symbol.asyncIterator] = async function* (this: ReadableStream) {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

export {};
