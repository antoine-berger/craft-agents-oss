import './session-activity.css'

/** Conductor's chat-row typing/waiting frames, rendered as a CSS mask without a Lottie runtime. */
export function SessionActivity({ waiting = false }: { waiting?: boolean }) {
  return <span aria-hidden="true" className={`session-activity ${waiting ? 'session-activity-waiting' : 'session-activity-working'}`} />
}
