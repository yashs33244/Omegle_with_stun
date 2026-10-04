import { Link } from "react-router-dom";
import { LegalPage, Todo } from "./LegalPage";

const LawEnforcement = () => (
  <LegalPage title="Law enforcement requests">
    <p>
      This page is for police, courts and government agencies. Users looking for help should see the{" "}
      <Link to="/safety">Safety page</Link>.
    </p>

    <h2>How to send a request</h2>
    <ul>
      <li>
        Email: <Todo>law enforcement email address</Todo>
      </li>
      <li>Send requests from an official address, citing the legal basis and the authority that issued it.</li>
      <li>Requests from outside India may need to go through the applicable mutual legal assistance process.</li>
    </ul>

    <h2>Emergencies</h2>
    <p>
      If there is an imminent risk of death or serious harm, mark the request as an emergency and explain the risk. We
      review emergency requests as a priority. <Todo>emergency contact route</Todo>
    </p>

    <h2>What data may exist</h2>
    <p>
      Chizzy has no accounts and does not record video, audio or chat. What may exist, within the retention periods in
      the <Link to="/privacy">Privacy Policy</Link>:
    </p>
    <ul>
      <li>connection logs: IP address, time, country and pseudonymous device identifiers;</li>
      <li>match records: which pseudonymous devices were paired, and when;</li>
      <li>reports: the reason, one image captured by the reporter's device and up to 20 chat lines;</li>
      <li>restriction and ban records.</li>
    </ul>

    <h2>Preservation</h2>
    <p>
      We can preserve specific records while you obtain legal process. Send a preservation request with the details
      above.
    </p>

    <h2>Child sexual abuse material</h2>
    <p>
      We report apparent child sexual abuse material to NCMEC in the United States and to the relevant Indian
      authorities, and we preserve the related records.
    </p>
  </LegalPage>
);

export default LawEnforcement;
