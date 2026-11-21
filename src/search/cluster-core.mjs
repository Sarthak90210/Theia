// Groups faces into people. Plain JavaScript, run in the face worker because
// a first pass over a whole library compares every face with every other.
//
// Two steps, each conservative: two groups of one person are fixed by naming
// both the same, but one group of two people looks broken.
//
// 1. A face not yet in a person joins the person it is most like, when the
//    mean of its best three matches among that person's faces reaches the
//    threshold, it is also near that person's average face (`minCentre`: a
//    big group has three close matches for almost anyone), the person does not
//    already have a face in that photo, and nobody said "not this person".
// 2. The faces left are grouped density-first: faces at least `threshold`
//    alike (and never two from one photo) are neighbours; a face with two or
//    more neighbours is a core; cores linked by neighbourhood form a group,
//    and the other faces join their most alike core. A group seen in fewer
//    than `minPhotos` photos is left alone for now.
//
// Faces seen side-on describe a person poorly and chain different people
// together, so they never start a group; they may join someone already known
// when the match is clearly stronger (`sideOnMargin` above the threshold).

const D = 128

function dot(a, i, b, j) {
  let s = 0
  const x = i * D, y = j * D
  for (let k = 0; k < D; k++) s += a[x + k] * b[y + k]
  return s
}

/**
 * input: {
 *   free: Float32Array (n x 128), freeAsset: Int32Array (n),
 *   held: Float32Array (m x 128), heldAsset: Int32Array (m), heldPerson: Int32Array (m),
 *   rejects: [freeIndex, personId][], threshold, minPhotos,
 *   frontal: Uint8Array (n, 1 when the face looks roughly at the camera), sideOnMargin
 * }
 * returns { person: Int32Array (n, a person id or -1), group: Int32Array (n, a new group number or -1) }
 */
export function clusterFaces({ free, freeAsset, held, heldAsset, heldPerson, rejects = [], threshold = 0.55, minPhotos = 3, frontal, sideOnMargin = 0.1, minCentre = 0.45, groupThreshold = threshold, minNeighbours = 2 }) {
  const isFrontal = (i) => !frontal || frontal[i] === 1
  const n = freeAsset.length
  const m = heldAsset.length
  const person = new Int32Array(n).fill(-1)
  const group = new Int32Array(n).fill(-1)

  // 1. Join existing people.
  const people = new Map()
  for (let j = 0; j < m; j++) {
    const p = heldPerson[j]
    if (!people.has(p)) people.set(p, { faces: [], assets: new Set() })
    people.get(p).faces.push(j)
    people.get(p).assets.add(heldAsset[j])
  }
  for (const info of people.values()) {
    const c = new Float32Array(D)
    for (const j of info.faces) for (let k = 0; k < D; k++) c[k] += held[j * D + k]
    const len = Math.hypot(...c) || 1
    for (let k = 0; k < D; k++) c[k] /= len
    info.centre = c
  }
  const refused = new Set(rejects.map(([i, p]) => `${i}:${p}`))
  if (people.size) {
    for (let i = 0; i < n; i++) {
      let best = -1
      let bestScore = -Infinity
      for (const [p, info] of people) {
        if (info.assets.has(freeAsset[i]) || refused.has(`${i}:${p}`)) continue
        if (dot(free, i, info.centre, 0) < minCentre) continue
        const sims = info.faces.map((j) => dot(free, i, held, j)).sort((a, b) => b - a)
        const top = sims.slice(0, 3)
        const score = top.reduce((s, x) => s + x, 0) / top.length
        if (score > bestScore) {
          bestScore = score
          best = p
        }
      }
      if (best >= 0 && bestScore >= threshold + (isFrontal(i) ? 0 : sideOnMargin)) {
        person[i] = best
        people.get(best).assets.add(freeAsset[i])
      }
    }
  }

  // 2. Group the rest.
  const rest = []
  for (let i = 0; i < n; i++) if (person[i] < 0 && isFrontal(i)) rest.push(i)
  const neighbours = new Map(rest.map((i) => [i, []]))
  for (let a = 0; a < rest.length; a++) {
    const i = rest[a]
    for (let b = a + 1; b < rest.length; b++) {
      const j = rest[b]
      if (freeAsset[i] === freeAsset[j]) continue
      const s = dot(free, i, free, j)
      if (s >= groupThreshold) {
        neighbours.get(i).push([j, s])
        neighbours.get(j).push([i, s])
      }
    }
  }
  const core = (i) => neighbours.get(i).length >= minNeighbours
  const label = new Map()
  let next = 0
  for (const i of rest) {
    if (!core(i) || label.has(i)) continue
    const stack = [i]
    label.set(i, next)
    while (stack.length) {
      const p = stack.pop()
      for (const [q] of neighbours.get(p)) {
        if (core(q) && !label.has(q)) {
          label.set(q, next)
          stack.push(q)
        }
      }
    }
    next++
  }
  for (const i of rest) {
    if (label.has(i)) continue
    let best = null
    for (const [q, s] of neighbours.get(i)) if (core(q) && (!best || s > best[1])) best = [q, s]
    if (best) label.set(i, label.get(best[0]))
  }

  // One face per photo in a group (the most typical), and enough photos.
  const members = new Map()
  for (const [i, l] of label) {
    if (!members.has(l)) members.set(l, [])
    members.get(l).push(i)
  }
  let g = 0
  for (const faces of members.values()) {
    const typical = (i) => faces.reduce((s, j) => s + (i === j ? 0 : dot(free, i, free, j)), 0)
    const byAsset = new Map()
    for (const i of faces) {
      const other = byAsset.get(freeAsset[i])
      if (other === undefined || typical(i) > typical(other)) byAsset.set(freeAsset[i], i)
    }
    if (byAsset.size < minPhotos) continue
    for (const i of byAsset.values()) group[i] = g
    g++
  }
  return { person, group }
}
