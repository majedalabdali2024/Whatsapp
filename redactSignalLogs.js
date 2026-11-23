/**
 * libsignal (used by Baileys) prints whole Signal session objects to the console,
 * e.g. console.info('Closing session:', session) — including private keys.
 * Keep the message text for diagnostics but drop the object arguments.
 */
const SIGNAL_PREFIXES = [
    'Closing session',
    'Opening session',
    'Removing old closed session',
    'Session already closed',
    'Migrating session to',
]

const isSignalDump = (args) =>
    args.length > 1 && typeof args[0] === 'string' && SIGNAL_PREFIXES.some((p) => args[0].startsWith(p))

for (const level of ['info', 'warn', 'log']) {
    const original = console[level].bind(console)
    console[level] = (...args) => (isSignalDump(args) ? original(args[0].replace(/:\s*$/, '')) : original(...args))
}

export { isSignalDump }
