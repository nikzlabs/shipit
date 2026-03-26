/**
 * RocketLaunch — animated empty-state for new sessions.
 *
 * The rocket sits at the bottom (just above the input bar), fires ignite
 * sideways first, then it smoothly accelerates upward and off-screen.
 */

export function RocketLaunch() {
  return (
    <div className="relative h-full w-full select-none overflow-hidden rocket-scene">
      {/* Stars layer */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="star star-1" />
        <div className="star star-2" />
        <div className="star star-3" />
        <div className="star star-4" />
        <div className="star star-5" />
        <div className="star star-6" />
        <div className="star star-7" />
        <div className="star star-8" />
      </div>

      {/* Rocket anchored to the bottom center */}
      <div className="rocket-container">
        {/* Exhaust glow */}
        <div className="exhaust-glow" />

        {/* Exhaust particles */}
        <div className="particles">
          <div className="particle p1" />
          <div className="particle p2" />
          <div className="particle p3" />
          <div className="particle p4" />
          <div className="particle p5" />
          <div className="particle p6" />
          <div className="particle p7" />
          <div className="particle p8" />
        </div>

        {/* Rocket SVG */}
        <svg
          className="rocket-svg"
          viewBox="100 60 312 500"
          width="100"
          height="170"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="rl-rocketGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" style={{ stopColor: "#e94560" }} />
              <stop offset="50%" style={{ stopColor: "#e94560" }} />
              <stop offset="100%" style={{ stopColor: "#c23152" }} />
            </linearGradient>
            <linearGradient id="rl-flameGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" style={{ stopColor: "#ff6b35" }} />
              <stop offset="40%" style={{ stopColor: "#f7c948" }} />
              <stop offset="100%" style={{ stopColor: "#f7c948", stopOpacity: 0.3 }} />
            </linearGradient>
            <linearGradient id="rl-windowGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style={{ stopColor: "#a8d8ea" }} />
              <stop offset="100%" style={{ stopColor: "#5eb7e0" }} />
            </linearGradient>
            <filter id="rl-glow">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="rl-flameGlow" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="10" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Flame — ignites sideways first, then grows downward */}
          <g filter="url(#rl-flameGlow)" className="flame-group">
            <path
              d="M256 400 L236 440 Q256 490 256 490 Q256 490 276 440 Z"
              fill="url(#rl-flameGrad)"
              opacity="0.9"
              className="flame-main"
            />
            <path
              d="M240 395 L220 440 Q240 465 245 400 Z"
              fill="#ff6b35"
              opacity="0.6"
              className="flame-left"
            />
            <path
              d="M272 395 L292 440 Q272 465 267 400 Z"
              fill="#ff6b35"
              opacity="0.6"
              className="flame-right"
            />
          </g>

          {/* Rocket body */}
          <g filter="url(#rl-glow)">
            <path
              d="M256 80 C256 80 220 140 215 220 L215 340 Q215 360 235 370 L245 375 L245 395 L267 395 L267 375 L277 370 Q297 360 297 340 L297 220 C292 140 256 80 256 80 Z"
              fill="url(#rl-rocketGrad)"
            />
            <path
              d="M256 80 C256 80 238 130 232 190 L232 200 Q244 180 256 80 Z"
              fill="#ffffff"
              opacity="0.25"
            />
            <circle cx="256" cy="210" r="30" fill="url(#rl-windowGrad)" stroke="#ffffff" strokeWidth="3" opacity="0.9" />
            <circle cx="248" cy="203" r="8" fill="#ffffff" opacity="0.4" />
            <rect x="220" y="290" width="72" height="6" rx="3" fill="#ffffff" opacity="0.15" />
            <rect x="225" y="305" width="62" height="4" rx="2" fill="#ffffff" opacity="0.1" />
            <path d="M215 310 L175 375 L175 385 Q185 380 215 360 Z" fill="#c23152" stroke="#e94560" strokeWidth="1" />
            <path d="M297 310 L337 375 L337 385 Q327 380 297 360 Z" fill="#c23152" stroke="#e94560" strokeWidth="1" />
          </g>
        </svg>
      </div>

      {/* Smoke clouds — anchored at bottom, independent of rocket movement */}
      <div className="smoke-clouds">
        <div className="smoke s1" />
        <div className="smoke s2" />
        <div className="smoke s3" />
        <div className="smoke s4" />
      </div>
    </div>
  );
}
