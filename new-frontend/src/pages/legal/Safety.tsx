import { Link } from "react-router-dom";
import { LegalPage } from "./LegalPage";

const Safety = () => (
  <LegalPage title="Safety">
    <h2>If you are in danger</h2>
    <p>
      <strong>Call your local emergency number</strong> (112 in India, 911 in the United States).
    </p>

    <h2>Helplines</h2>
    <h3>India</h3>
    <ul data-testid="helplines-india">
      <li>
        <strong>1930</strong>: National Cyber Crime Helpline. You can also report at{" "}
        <a href="https://cybercrime.gov.in" target="_blank" rel="noopener noreferrer">
          cybercrime.gov.in
        </a>
        .
      </li>
      <li>
        <strong>1098</strong>: Childline, for children and young people who need help.
      </li>
    </ul>
    <h3>United States</h3>
    <ul data-testid="helplines-us">
      <li>
        <strong>988</strong>: Suicide and Crisis Lifeline. Call or text, any time.
      </li>
      <li>
        <strong>NCMEC CyberTipline</strong>: report the online sexual exploitation of a child at{" "}
        <a href="https://report.cybertip.org" target="_blank" rel="noopener noreferrer">
          report.cybertip.org
        </a>{" "}
        or call 1-800-843-5678.
      </li>
    </ul>
    <h3>Anywhere else</h3>
    <p>Call your local emergency number, or a local helpline for crisis support.</p>

    <h2>If someone threatens to share images of you (sextortion)</h2>
    <ul>
      <li>Do not pay and do not send more images. Paying rarely stops the demands.</li>
      <li>Stop replying, but keep the messages as evidence.</li>
      <li>Report the person in Chizzy and to the police (1930 in India).</li>
      <li>
        If the images are of you under 18,{" "}
        <a href="https://takeitdown.ncmec.org" target="_blank" rel="noopener noreferrer">
          Take It Down
        </a>{" "}
        (NCMEC) can help stop them spreading. Adults can use{" "}
        <a href="https://stopncii.org" target="_blank" rel="noopener noreferrer">
          StopNCII.org
        </a>
        .
      </li>
      <li>
        If an image of you came from Chizzy, ask us to remove it with our <Link to="/takedown">takedown form</Link>.
      </li>
    </ul>

    <h2>How Chizzy tries to keep calls safer</h2>
    <ul>
      <li>An age check before the camera turns on. It stops honest children; it cannot stop everyone who lies.</li>
      <li>A bot check before you start.</li>
      <li>On-device checks that can blur a partner's video that looks unsafe. They can miss things.</li>
      <li>Links, handles and phone numbers are hidden in chat for the first minutes of a call.</li>
      <li>One-tap reporting during a call and for a short time after it. People on our team review reports.</li>
    </ul>
    <p>
      No tool catches everything. End the call with Next or Report whenever something feels wrong, and do not share
      personal details with strangers.
    </p>
  </LegalPage>
);

export default Safety;
