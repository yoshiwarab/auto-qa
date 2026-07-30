import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Route,
  Routes,
} from "react-router-dom";
import "./styles.css";

const AccountPage = () => (
  <>
    <header className="page-heading">
      <div>
        <p className="eyebrow">Workspace settings</p>
        <h1>Account</h1>
        <p className="page-intro">
          Review the profile and plan details associated with this
          workspace.
        </p>
      </div>
      <span className="status-badge">
        <span aria-hidden="true" className="status-dot" />
        Account active
      </span>
    </header>

    <section aria-labelledby="profile-heading" className="card">
      <div className="card-heading">
        <div>
          <p className="section-kicker">Profile</p>
          <h2 id="profile-heading">Personal details</h2>
        </div>
        <span className="initials" aria-hidden="true">
          AR
        </span>
      </div>
      <dl className="detail-grid">
        <div>
          <dt>Name</dt>
          <dd>Alex Rivera</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>alex.rivera@example.test</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>Workspace administrator</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>North America</dd>
        </div>
      </dl>
    </section>

    <div className="card-grid">
      <section aria-labelledby="plan-heading" className="card">
        <p className="section-kicker">Subscription</p>
        <h2 id="plan-heading">Team plan</h2>
        <p className="metric">
          12 <span>of 20 seats used</span>
        </p>
        <div
          aria-label="12 of 20 seats used"
          aria-valuemax={20}
          aria-valuemin={0}
          aria-valuenow={12}
          className="progress"
          role="progressbar"
        >
          <span />
        </div>
        <p className="muted">Renews on September 18, 2026</p>
      </section>

      <section aria-labelledby="security-heading" className="card">
        <p className="section-kicker">Security</p>
        <h2 id="security-heading">Security posture</h2>
        <ul className="status-list">
          <li>
            <span aria-hidden="true">✓</span>
            Email verified
          </li>
          <li>
            <span aria-hidden="true">✓</span>
            Two-step verification enabled
          </li>
          <li>
            <span aria-hidden="true">✓</span>
            Recovery contact configured
          </li>
        </ul>
      </section>
    </div>
  </>
);

const NotFoundPage = () => (
  <section className="card not-found">
    <p className="eyebrow">404 · Not found</p>
    <h1>Page not found</h1>
    <p>The page you requested is not part of this workspace.</p>
    <NavLink className="text-link" to="/">
      Return to Account
    </NavLink>
  </section>
);

const App = () => (
  <BrowserRouter>
    <div className="app-shell">
      <header className="app-header">
        <NavLink aria-label="QA Lab home" className="brand" to="/">
          <span aria-hidden="true" className="brand-mark">
            Q
          </span>
          <span>QA Lab</span>
        </NavLink>
        <nav aria-label="Primary navigation">
          <NavLink
            className={({ isActive }) =>
              isActive ? "nav-link active" : "nav-link"
            }
            end
            to="/"
          >
            Account
          </NavLink>
        </nav>
        <span className="environment">Test workspace</span>
      </header>
      <main>
        <Routes>
          <Route element={<AccountPage />} path="/" />
          <Route element={<NotFoundPage />} path="*" />
        </Routes>
      </main>
    </div>
  </BrowserRouter>
);

const root = document.getElementById("root");
if (root === null) {
  throw new Error("QA Lab root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
