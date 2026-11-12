// Stand-in command: stays running for the given number of seconds, then exits 0.
setTimeout(() => {}, Number(process.argv[2] ?? 1) * 1000);
