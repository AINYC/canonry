/**
 * Asking for something that must not appear on screen.
 *
 * A password typed at a prompt is the only way to create an account without
 * leaving it in a shell history file, a process list, or a CI log. This is why
 * `canonry user create` has no `--password` flag: the two ways in are typing it
 * here, or piping it on standard input.
 */
import readline from 'node:readline'

/**
 * Read one line from the terminal without echoing what is typed.
 *
 * Falls back to a normal (echoing) read when there is no terminal — a pipe or a
 * CI runner — because the alternative is hanging forever waiting for a keypress
 * that is never coming.
 */
export async function promptHiddenInput(question: string): Promise<string> {
  const input = process.stdin
  const output = process.stdout

  if (!input.isTTY) {
    const rl = readline.createInterface({ input, output })
    try {
      return await new Promise<string>(resolve => { rl.question(question, resolve) })
    } finally {
      rl.close()
    }
  }

  const rl = readline.createInterface({ input, output, terminal: true })
  // `readline` writes each keystroke back to the terminal. Replacing that write
  // with the prompt itself keeps the cursor where it belongs while showing
  // nothing of what is being typed.
  const mutable = rl as unknown as { _writeToOutput?: (chunk: string) => void }
  const originalWrite = mutable._writeToOutput?.bind(rl)
  let muted = false
  mutable._writeToOutput = (chunk: string) => {
    if (muted) {
      output.write('')
      return
    }
    originalWrite?.(chunk)
  }

  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        output.write('\n')
        resolve(answer)
      })
      muted = true
    })
  } finally {
    muted = false
    if (originalWrite) mutable._writeToOutput = originalWrite
    rl.close()
  }
}

/** Read everything piped on standard input, for `--password-stdin`. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}
