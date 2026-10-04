import { LegalPage, Todo } from "./LegalPage";

/** Retention table from LAUNCH_PLAN LB-16 (the lawyer confirms it). */
const RETENTION: ReadonlyArray<readonly [string, string]> = [
  ["Connection and application logs (connections, IP addresses, matches)", "180 days rolling, stored in India"],
  ["Reports and their evidence (non-CSAM)", "1 year, then deleted automatically"],
  ["Suspected child sexual abuse material and its report metadata", "1 year after the report, in a restricted store that can be put on legal hold"],
  ["Ban records (hashed device keys)", "Length of the ban plus 1 year"],
  ["Age check outcome (18 or older, Terms version, time)", "While the device is active, plus 180 days"],
  ["Under-18 lockout", "A salted hash and the date only; nothing else"],
  ["Date of birth", "Not stored. Only the outcome is kept"],
  ["Chat messages", "Not stored, except the lines attached to a report"],
  ["Video and audio", "Not recorded. A single image is kept only when someone reports a call"],
  ["Call quality telemetry", "No IP addresses; aggregated after 90 days"],
];

const Privacy = () => (
  <LegalPage title="Privacy Policy">
    <p>
      This policy explains what <Todo>legal entity name</Todo> ("Chizzy", "we") collects when you use Chizzy, why, who
      we share it with and how long we keep it. Chizzy has no accounts. We do not use advertising or analytics
      cookies.
    </p>

    <h2>Your IP address and your chat partner</h2>
    <p data-testid="privacy-ip-disclosure">
      <strong>
        In the default peer-to-peer mode, your video call connects your browser directly to your partner's browser, so
        your partner's browser receives your IP address.
      </strong>{" "}
      An IP address can reveal your approximate location and your internet provider. If you turn on{" "}
      <strong>Hide my IP</strong>, the call goes through a relay server (run by Cloudflare) and your partner's browser
      receives the relay's address instead of yours. Hide my IP may sometimes be unavailable; when it is off, calls are
      peer-to-peer.
    </p>

    <h2>What we collect</h2>
    <ul>
      <li>
        <strong>Age check:</strong> you enter your date of birth, our server works out whether you are 18 or older and
        keeps only that outcome, the Terms version you accepted and the time. We do not store your date of birth.
      </li>
      <li>
        <strong>Profile you choose:</strong> display name, country, language, gender (used only for matching filters,
        not shown to partners), topics and an optional photo. These are passed to your partners during a match and are
        not saved by us after you leave.
      </li>
      <li>
        <strong>Device and network signals for anti-abuse:</strong> a random device id stored in your browser, a hash of
        coarse browser traits (browser version, language, time zone, screen size and processor count), your IP address
        and the country it maps to, the result of the Cloudflare Turnstile bot check, whether your camera looks like a
        virtual camera, how quickly calls are skipped, and counts (not content) from on-device safety checks. We use
        these to stop bots, enforce bans and lockouts, and limit abuse.
      </li>
      <li>
        <strong>Reports:</strong> when someone reports you, or you report someone, we keep the report, one image from
        the video captured by the reporter's device, and up to the last 20 chat lines.
      </li>
      <li>
        <strong>Call telemetry:</strong> whether the call connected, how long it took, connection type and quality
        figures. No IP addresses and no content.
      </li>
      <li>
        <strong>Errors and product analytics:</strong> crash reports with names, chat text and images removed, and
        anonymous usage events (for example "call connected") without cookies and without your IP address.
      </li>
    </ul>
    <p>We do not record video, audio or chat.</p>

    <h2>Who processes data for us</h2>
    <ul>
      <li>
        <strong>Cloudflare</strong>: content delivery and protection, the Turnstile bot check, and the relay servers used
        for Hide my IP and for calls that cannot connect directly.
      </li>
      <li>
        <strong>Sentry</strong>: error reports from the app and the server.
      </li>
      <li>
        <strong>PostHog</strong>: anonymous, cookieless product analytics.
      </li>
      <li>
        <strong>Hosting:</strong> <Todo>hosting provider and region</Todo>.
      </li>
    </ul>
    <p>
      Some of these providers store data outside India, including in the United States. <Todo>cross-border transfer
      basis, to be written by the lawyer</Todo>
    </p>

    <h2>How long we keep data</h2>
    <table data-testid="retention-table">
      <thead>
        <tr>
          <th scope="col">Data</th>
          <th scope="col">Retention</th>
        </tr>
      </thead>
      <tbody>
        {RETENTION.map(([data, period]) => (
          <tr key={data}>
            <td>{data}</td>
            <td>{period}</td>
          </tr>
        ))}
      </tbody>
    </table>

    <h2>Storage on your device</h2>
    <p>
      Chizzy keeps a few items in your browser's local storage: the random device id, a token that proves you passed the
      age check (up to 180 days), a session token (24 hours) and, if your date of birth was under 18, a lockout marker.
      These are needed for the service to work and to keep it safe.
    </p>

    <h2>Children</h2>
    <p>
      Chizzy is for adults. If we learn that a person under 18 is using it, we lock them out. For a locked-out
      device we aim to keep only a salted hash and the date, as set out in the table above, plus anything the law
      requires us to keep.
    </p>

    <h2>Your rights</h2>
    <p>
      Depending on where you live, you can ask to access, correct or delete data about you, and complain to a data
      protection authority. Because Chizzy has no accounts, we may ask for details such as when you used Chizzy so
      we can find data about you. Contact <Todo>privacy contact email</Todo> or our <a href="/grievance">Grievance Officer</a>.
    </p>

    <h2>Law enforcement</h2>
    <p>
      We share data with authorities when the law requires it, and we report child sexual abuse material to the
      authorities (NCMEC in the United States and the relevant Indian authorities).
    </p>

    <h2>Changes</h2>
    <p>We will update this page and the date above when this policy changes.</p>
  </LegalPage>
);

export default Privacy;
