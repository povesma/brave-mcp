// Stand-in command: prints its first argument and a line break on standard output.
process.stdout.write(`${process.argv[2] ?? ""}\n`);
