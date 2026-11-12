// Stand-in command: reports its process id to the URL given as its first
// argument (as ?pid=N), then stays running for the given number of seconds.
const [url, seconds = "60"] = process.argv.slice(2);
setTimeout(() => {}, Number(seconds) * 1000);
await fetch(`${url}?pid=${process.pid}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
