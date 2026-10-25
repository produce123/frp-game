import { el } from '../svg'
import type { Appearance } from './types'
import { defaultAppearance } from './appearances'
export function propGlyph(id: string, x: number, y: number, a: Appearance = defaultAppearance) {
  const g = el('g', {
    class: 'pp',
    'data-prop-id': id,
    transform: `translate(${x} ${y})`,
    role: 'button',
    tabindex: 0,
    'aria-label': '查看道具',
  })
  const frame = el('rect', {
    x: -25,
    y: -22,
    width: 50,
    height: 44,
    rx: 3,
    fill: a.color,
    stroke: '#423d32',
    'stroke-width': 2,
  })
  g.appendChild(frame)
  if (a.image) {
    g.appendChild(
      el('image', {
        href: a.image,
        x: -24,
        y: -21,
        width: 48,
        height: 42,
        preserveAspectRatio: 'xMidYMid meet',
      })
    )
    return g
  }
  const paths = {
    box: 'M-13-9H13V10H-13ZM0-9V10',
    bed: 'M-17-10H17V10H-17ZM-7-10V10M-17 10V15M17 10V15',
    book: 'M0-10Q-9-15-17-10V12Q-9 7 0 12Q9 7 17 12V-10Q9-15 0-10V12',
    plant: 'M0 15V-10M0 2Q-20 2-12-12Q0-12 0 2M0-3Q18-12 14-16Q0-16 0-3',
    machine: 'M-15-15H15V15H-15ZM-9-8H9V0H-9ZM-9 8H9',
  }
  g.appendChild(
    el('path', {
      d: paths[a.glyph],
      fill: 'none',
      stroke: '#263a31',
      'stroke-width': 3,
    })
  )
  return g
}
