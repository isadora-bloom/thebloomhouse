// @vitest-environment jsdom
/**
 * Seating board (NOVEMBER-PLAN.md wave 6, W44).
 *
 * Proves the two things the Monday walkthrough could not do: put a named
 * guest on a table from the seating surface, and take one off again in one
 * click. Both go through the save callback the page wires to
 * `saveTableAssignment`, which is stubbed here, so the test needs no
 * database.
 *
 * No JSX on purpose: `createElement` keeps this a plain `.test.ts` file,
 * which is what vitest.config.ts's `include` glob picks up (it does not
 * include `.tsx`), so no test-runner config changes. Same trick as
 * src/lib/hooks/__tests__/use-now.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SeatingBoard } from '../seating-board'
import {
  buildSeatingView,
  type SeatingGuestRow,
  type SeatingTableRow,
} from '@/lib/services/couple-portal/seating-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABLES: SeatingTableRow[] = [
  { id: 't1', table_name: 'Table 1', table_type: 'round', capacity: 2, sort_order: 0 },
]

const GUESTS: SeatingGuestRow[] = [
  { id: 'g1', first_name: 'Ana', last_name: 'Ruiz', table_assignment: 'Table 1' },
  { id: 'g2', first_name: 'Ben', last_name: 'Okafor', table_assignment: null },
  { id: 'g3', first_name: 'Cara', last_name: 'Nwosu', table_assignment: null },
]

describe('SeatingBoard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Partial<Parameters<typeof SeatingBoard>[0]> = {}) {
    const view = props.view ?? buildSeatingView({ tables: TABLES, guests: GUESTS })
    const onAssign = props.onAssign ?? vi.fn()
    const onUnassign = props.onUnassign ?? vi.fn()
    act(() => {
      root.render(createElement(SeatingBoard, { ...props, view, onAssign, onUnassign }))
    })
    return { onAssign, onUnassign }
  }

  function byLabel(label: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`[aria-label="${label}"]`)
    if (!el) throw new Error(`no element labelled "${label}"`)
    return el
  }

  function click(el: HTMLElement) {
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('shows who is seated where and how much room is left', () => {
    render()
    const card = container.querySelector('[data-table-card="Table 1"]')!
    expect(card.textContent).toContain('Ana Ruiz')
    expect(card.textContent).toContain('1 seat left')
    // The two unseated parties are on the side, ready to drag.
    const unseated = container.querySelector('[data-testid="seating-unseated"]')!
    expect(unseated.textContent).toContain('Ben Okafor')
    expect(unseated.textContent).toContain('Cara Nwosu')
  })

  it('seats a guest through the save callback', () => {
    const { onAssign } = render()
    click(byLabel('Add a guest to Table 1'))
    click(byLabel('Seat Ben Okafor at Table 1'))
    expect(onAssign).toHaveBeenCalledTimes(1)
    expect(onAssign).toHaveBeenCalledWith('g2', 'Table 1')
  })

  it('narrows the picker by name', () => {
    render()
    click(byLabel('Add a guest to Table 1'))
    const search = byLabel('Search guests to seat at Table 1') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(search, 'cara')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[aria-label="Seat Cara Nwosu at Table 1"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Seat Ben Okafor at Table 1"]')).toBeNull()
  })

  it('takes a guest off a table in one click', () => {
    const { onUnassign } = render()
    click(byLabel('Remove Ana Ruiz from Table 1'))
    expect(onUnassign).toHaveBeenCalledTimes(1)
    expect(onUnassign).toHaveBeenCalledWith('g1')
  })

  it('says a table is over capacity in plain words and still allows the save', () => {
    const view = buildSeatingView({
      tables: TABLES,
      guests: [
        { id: 'g1', first_name: 'Ana', last_name: 'Ruiz', table_assignment: 'Table 1' },
        { id: 'g4', first_name: 'Dee', last_name: 'Hall', table_assignment: 'Table 1' },
        { id: 'g5', first_name: 'Eli', last_name: 'Frost', table_assignment: 'Table 1' },
        { id: 'g2', first_name: 'Ben', last_name: 'Okafor', table_assignment: null },
      ],
    })
    const { onAssign } = render({ view })
    const card = container.querySelector('[data-table-card="Table 1"]')!
    expect(card.textContent).toContain('1 seat over capacity')

    // The picker warns, and the button still works.
    click(byLabel('Add a guest to Table 1'))
    expect(card.textContent).toContain('You can still seat someone here')
    const seat = byLabel('Seat Ben Okafor at Table 1') as HTMLButtonElement
    expect(seat.disabled).toBe(false)
    click(seat)
    expect(onAssign).toHaveBeenCalledWith('g2', 'Table 1')
  })

  it('offers show-on-map only when the table is drawn on the plan', () => {
    render()
    // No floor plan passed, so nothing to point at.
    expect(container.querySelector('[aria-label="Show Table 1 on the map"]')).toBeNull()

    const view = buildSeatingView({
      tables: TABLES,
      guests: GUESTS,
      mapElements: [
        { id: 'e1', type: 'round', label: 'Table 1', x: 100, y: 100, feetW: 5, feetH: 5 },
      ],
    })
    render({
      view,
      floorPlanUrl: 'https://example.test/plan.png',
      mapElements: [
        { id: 'e1', type: 'round', label: 'Table 1', x: 100, y: 100, feetW: 5, feetH: 5 },
      ],
    })
    expect(container.querySelector('[aria-label="Show Table 1 on the map"]')).not.toBeNull()
  })

  it('changes nothing when read only', () => {
    render({ readOnly: true })
    expect(container.querySelector('[aria-label="Add a guest to Table 1"]')).toBeNull()
    expect(container.querySelector('[aria-label="Remove Ana Ruiz from Table 1"]')).toBeNull()
    // It still shows the whole picture.
    expect(container.textContent).toContain('Ana Ruiz')
    expect(container.textContent).toContain('Ben Okafor')
  })
})
