import { StringDecoder } from 'node:string_decoder';

export async function* completeLines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of input) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, end);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.end();
  if (pending) yield pending;
}
