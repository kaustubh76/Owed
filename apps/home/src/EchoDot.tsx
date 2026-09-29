/**
 * An Echo Dot: the surface with no screen.
 *
 * Here to be a proof rather than a decoration. Alexa+ requires every critical feature
 * to be completable by voice alone, and the only honest way to show that is to take the
 * card away and do the whole storyboard again. Nothing about the add-on changes — the
 * same tools return the same single spoken line, and this surface simply declines to
 * render the card that comes with it.
 *
 * If a beat stops making sense here, the spoken line was a caption for a picture, and
 * that is a bug in the add-on rather than in this component.
 */
export function EchoDot({ reply, listening }: { reply: string | null; listening: boolean }) {
  return (
    <div className="dot">
      <div className={`dot__body${listening ? " dot__body--live" : ""}`}>
        <div className="dot__ring" />
        <p className="dot__speech">{reply ? `“${reply}”` : "Ask Owed what you are owed."}</p>
      </div>
      <p className="dot__label">Echo Dot &middot; no screen, voice only</p>
    </div>
  );
}
