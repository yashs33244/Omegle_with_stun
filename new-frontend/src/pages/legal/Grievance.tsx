import { Link } from "react-router-dom";
import { LegalPage, Todo } from "./LegalPage";

const Grievance = () => (
  <LegalPage title="Grievance Officer">
    <p>
      Under India's Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021, you can
      raise a complaint about content on Chizzy or about how we applied our rules to you.
    </p>

    <h2>Contact</h2>
    <ul data-testid="grievance-contact">
      <li>
        Grievance Officer: <Todo>name of the Grievance Officer</Todo>
      </li>
      <li>
        Email: <Todo>grievance email address</Todo>
      </li>
      <li>
        Address: <Todo>postal address</Todo>
      </li>
    </ul>

    <h2>Timelines</h2>
    <ul>
      <li>We acknowledge a complaint within 24 hours of receiving it.</li>
      <li>We aim to resolve it within 15 days.</li>
      <li>
        Complaints about intimate images of you, or images of you that were altered, have shorter legal deadlines. Use
        the <Link to="/takedown">takedown form</Link> so they reach the right queue at once.
      </li>
    </ul>

    <h2>What to include</h2>
    <ul>
      <li>What happened and roughly when (date, time and time zone).</li>
      <li>Any display name you saw, and what you would like us to do.</li>
      <li>An email address where we can reach you.</li>
    </ul>

    <h2>If you are not satisfied</h2>
    <p>
      You can appeal the Grievance Officer's decision to the Grievance Appellate Committee within 30 days at{" "}
      <a href="https://gac.gov.in" target="_blank" rel="noopener noreferrer">
        gac.gov.in
      </a>
      .
    </p>
  </LegalPage>
);

export default Grievance;
