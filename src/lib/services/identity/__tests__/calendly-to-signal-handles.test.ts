/**
 * W25 (NOVEMBER-PLAN.md wave 3) — Calendly custom-question handle
 * mapping. HANDLE-IDENTITY-SPEC.md §4: "if a venue's Calendly event has
 * a question whose label mentions Instagram or handle, map its answer
 * onto handles.instagram." Never assume the question exists.
 */
import { describe, it, expect } from 'vitest'
import { calendlyToNormalizedSignal } from '../calendly-to-signal'

describe('calendlyToNormalizedSignal — handle question mapping (Wave 3)', () => {
  it('maps a question whose label mentions "Instagram" onto handles.instagram', () => {
    const signal = calendlyToNormalizedSignal({
      event: 'invitee_created',
      payload: {
        email: 'rosie@example.com',
        name: 'Rosie Hoyle',
        uri: 'https://calendly.com/x/1',
        questions_and_answers: [
          { question: "What's your Instagram?", answer: '@rosie.hoyle' },
        ],
      },
    })
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('maps a question whose label mentions "handle" (no "Instagram" word) onto handles.instagram', () => {
    const signal = calendlyToNormalizedSignal({
      event: 'invitee_created',
      payload: {
        email: 'rosie@example.com',
        name: 'Rosie Hoyle',
        uri: 'https://calendly.com/x/2',
        questions_and_answers: [
          { question: 'Your handle (optional)', answer: 'https://instagram.com/rosie.hoyle' },
        ],
      },
    })
    expect(signal.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('question absent: handles is null, nothing invented', () => {
    const signal = calendlyToNormalizedSignal({
      event: 'invitee_created',
      payload: {
        email: 'rosie@example.com',
        name: 'Rosie Hoyle',
        uri: 'https://calendly.com/x/3',
        questions_and_answers: [
          { question: 'How many guests?', answer: '120' },
        ],
      },
    })
    expect(signal.handles).toBeNull()
  })

  it('question present but answer does not normalise: handles is null, not the raw junk', () => {
    const signal = calendlyToNormalizedSignal({
      event: 'invitee_created',
      payload: {
        email: 'rosie@example.com',
        name: 'Rosie Hoyle',
        uri: 'https://calendly.com/x/4',
        questions_and_answers: [
          { question: 'Instagram handle', answer: 'not a handle at all!!' },
        ],
      },
    })
    expect(signal.handles).toBeNull()
  })

  it('carries onto tour_cancelled and tour_attended branches too', () => {
    const qa = [{ question: 'Instagram', answer: '@rosie.hoyle' }]
    const cancelled = calendlyToNormalizedSignal({
      event: 'invitee_canceled',
      payload: { email: 'rosie@example.com', questions_and_answers: qa },
    })
    expect(cancelled.handles).toEqual({ instagram: 'rosie.hoyle' })

    const attended = calendlyToNormalizedSignal({
      event: 'attended_derived',
      payload: { email: 'rosie@example.com', questions_and_answers: qa },
    })
    expect(attended.handles).toEqual({ instagram: 'rosie.hoyle' })
  })
})
