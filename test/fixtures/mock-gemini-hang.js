#!/usr/bin/env node

process.stderr.write("Waiting for authentication...\n")

setInterval(() => {
  process.stderr.write("Still waiting for authentication...\n")
}, 1000)
