# dimgrid — API Reference

Full type signatures, behaviour details, and edge cases.

## `dimgrid()`

```typescript
function dimgrid(): DimGrid<{}>
```

Creates a new grid with a single empty point (`{}`). All chains start here.

## `DimGrid<T>`

An immutable, lazy grid of typed points. Every method returns a new `DimGrid` — the original is never mutated.

### `.dim(key, values)`

```typescript
// Static values
dim<K extends string, const V>(
  key: K,
  values: readonly V[],
): DimGrid<T & { [P in K]: V }>

// Dynamic values (function form)
dim<K extends string, const V>(
  key: K,
  values: (point: T) => readonly V[],
): DimGrid<T & { [P in K]: V }>
```

Expands every existing point by the given values. For each existing point `P` and each value `V`, a new point `{ ...P, [key]: V }` is produced.

**Static form** (`values` is an array):
- Values are fixed at call time.
- `.size` is computed in O(dimensions) without iteration.

**Dynamic form** (`values` is a function):
- The function receives the current point (all keys added before this `.dim()` call) and returns the values for this dimension.
- Return `[]` to drop the point — it will not appear in the output.
- `.size` requires full iteration (O(points)) when any dimension uses a function.
- The function is called once per parent point during iteration, not at `.dim()` call time.

**Merging behaviour (duplicate key):**

If `key` already exists in the grid, the new values are merged into that dimension rather than adding a new one:

- Static + static → new static dimension with `deduped([...existing, ...new])` values.
- Static + dynamic or dynamic + anything → dynamic resolver that concatenates both result sets, then dedupes.

```typescript
dimgrid()
  .dim('x', [1, 2])
  .dim('x', [2, 3])  // merges: [1, 2, 3]
  .toArray()
// [{ x: 1 }, { x: 2 }, { x: 3 }]
```

### `.toArray()`

```typescript
toArray(): T[]
```

Materialises all points into a plain array. Equivalent to `[...grid]`.

### `.size`

```typescript
get size(): number
```

Returns the total number of points.

- **Static grids** (all dimensions use arrays): O(D) — multiplies dimension lengths, no iteration required. Result is cached after the first access.
- **Dynamic grids** (any dimension uses a function): O(N) — iterates all points and counts. Not cached, since resolvers may depend on external state.

### `[Symbol.iterator]`

```typescript
[Symbol.iterator](): Iterator<T>
```

Makes `DimGrid` directly iterable. Points are yielded lazily — no intermediate array is allocated.

```typescript
for (const point of grid) { ... }
const points = [...grid]
Array.from(grid)
```

### `DimGrid` class export

The class is exported for use in type annotations:

```typescript
import { DimGrid } from 'dimgrid'

function processGrid<T extends object>(grid: DimGrid<T>): T[] {
  return grid.toArray()
}
```

## Type inference

TypeScript infers the point type incrementally through the chain. The `const V` constraint preserves literal types rather than widening to `string` or `number`.

```typescript
const g1 = dimgrid()
//    ^? DimGrid<{}>

const g2 = g1.dim('color', ['red', 'green'])
//    ^? DimGrid<{ color: 'red' | 'green' }>

const g3 = g2.dim('size', ['S', 'M', 'L'])
//    ^? DimGrid<{ color: 'red' | 'green'; size: 'S' | 'M' | 'L' }>

const points = g3.toArray()
//    ^? { color: 'red' | 'green'; size: 'S' | 'M' | 'L' }[]
```

## Point generation order

Points are generated in **row-major order**: the first dimension added varies slowest, the last varies fastest.

```typescript
dimgrid()
  .dim('a', [1, 2])
  .dim('b', ['x', 'y'])
  .toArray()
// [{ a: 1, b: 'x' }, { a: 1, b: 'y' }, { a: 2, b: 'x' }, { a: 2, b: 'y' }]
```

## Deduplication details

Values are deduped using `JSON.stringify` equality when merging a duplicate key:

- Primitives: compared by value (`1 === 1`, `'a' === 'a'`)
- Plain objects: compared by serialised form — `{ x: 1 }` and `{ x: 1 }` are treated as the same
- `undefined`: `JSON.stringify(undefined)` returns `undefined` (not a string) — avoid `undefined` as a grid value
- Class instances: compared by their JSON representation, not by reference

## Exports

```typescript
import { dimgrid, DimGrid } from 'dimgrid'
```

| Export | Kind | Description |
|--------|------|-------------|
| `dimgrid` | function | Factory — creates an empty `DimGrid<{}>` |
| `DimGrid` | class | The grid class — useful for type annotations |
