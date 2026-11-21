// Stand-in command: requests the URL given as its first argument and prints the
// reply body. Exits 3 when the reply status is not 200, and 4 when there is no
// reply within 10 seconds.
try {
  const response = await fetch(process.argv[2], { signal: AbortSignal.timeout(10_000) });
  process.stdout.write(await response.text());
  process.exitCode = response.status === 200 ? 0 : 3;
} catch {
  process.exitCode = 4;
}
