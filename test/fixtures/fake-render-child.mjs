// Stands in for the thumbnail process in test/render-host.test.ts. A file
// named "*crash*" kills the process outright, the way a native decoder
// failing fast does; "*slow*" answers after a while; anything else at once.
process.on('message', (m) => {
  if (m.file.includes('crash')) process.exit(0xc0000409 | 0)
  const answer = () => process.send({ id: m.id, ok: true, result: { width: 4, height: 3 } })
  if (m.file.includes('slow')) setTimeout(answer, 300)
  else answer()
})
