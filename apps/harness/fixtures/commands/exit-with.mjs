// Stand-in command: writes a line to both output streams, then exits with the given code.
process.stdout.write("stand-in standard output that must not be echoed\n");
process.stderr.write("stand-in standard error that must not be echoed\n");
process.exitCode = Number(process.argv[2] ?? 0);
