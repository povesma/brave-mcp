# Changelog

All notable changes to this project are documented in this file.

## [0.0.1] - Unreleased

First release.

### What this gives you

- **An AI agent that can use your own Brave browser, the one you already have
  open.** Nothing runs in the cloud and nothing is simulated: the agent sees and
  controls the real browser on your machine, the same way you would with a mouse
  and keyboard.
- **You can watch everything it does.** The browser window stays visible the whole
  time — you see every tab it opens, every page it navigates to, every click and
  every typed character, as it happens.
- **It can do the things you'd do by hand**, including: open and switch between
  tabs and windows; fill in and submit forms; click buttons and links; scroll,
  drag, and upload files; take screenshots and save pages as PDF; read what's on
  a page, including text a script can't easily see; and inspect the page's
  console messages, cookies, and network traffic when something needs debugging.
- **Any MCP-compatible AI assistant can use it** — Codex, Claude Code, Claude
  Desktop, or another — once it's registered as a tool for that assistant.
- **Saved scripts can replay a browser task without an AI watching each step.** A
  login, a repeated check, or any other sequence can be written once as a plain
  text file and played back later on its own.
- **It only works with your explicit permission.** The browser extension must be
  paired with a secret only you control, and nothing outside your own machine can
  reach it — there is no remote server in the loop.

### Known limitations

- There is no one-click installer yet; setup is done by following the steps in
  this repository.
- No app store listing, screenshots, or downloadable build exists yet — you set
  it up by installing the dependencies and running it from your own copy of this
  project.
- Pages with a strict security policy can block one advanced feature (running
  custom JavaScript on that page); everything else still works normally.
