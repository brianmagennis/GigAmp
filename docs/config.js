// GigAmp site configuration. Safe to commit: nothing here is a secret.
// There is no sign-in: taste is learned anonymously in the visitor's browser.
window.GIGAMP_CONFIG = {
  defaultCity: "vancouver",
  playlistPrefix: "GigAmp",
  tracksPerArtist: 2,

  // Set false to ship without the artist comparison game (All Gigs is unaffected).
  onboardingEnabled: true,

  // The comparison game. minRounds is the earliest it can finish, maxRounds the
  // hard ceiling. In between it stops as soon as settledAxes taste dimensions
  // have reached settledConf confidence, so a decisive visitor is done in five
  // and an inconsistent one is asked a couple more. Never a fixed number.
  onboarding: {
    minRounds: 5,
    maxRounds: 8,
    settledAxes: 4,
    settledConf: 0.5,
    // "Tune For You" asks this many further questions on the least certain axes
    // instead of starting over, and maxPasses caps how many pairs someone can
    // skip before we stop asking.
    tuneRounds: 3,
    maxPasses: 6
  },

  // For You rails: cards shown per rail, and how many a "more" link reveals.
  rails: {
    size: 2,
    expanded: 6
  }
};
