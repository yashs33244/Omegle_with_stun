import { Link } from "react-router-dom";
import { TOS_VERSION } from "@/lib/protocol";
import { LegalPage, Todo } from "./LegalPage";

const Terms = () => (
  <LegalPage title="Terms of Service" updated={`Version ${TOS_VERSION}`}>
    <p>
      These Terms are an agreement between you and <Todo>legal entity name and registered address</Todo> ("Chizzy",
      "we"). By using Chizzy you agree to them. If you do not agree, do not use Chizzy.
    </p>

    <h2>1. Who can use Chizzy</h2>
    <ul>
      <li>You must be 18 or older. We ask for your date of birth before the camera turns on, and a device that gives an under-18 date is locked out.</li>
      <li>Chizzy is not available in some countries. Do not use a VPN or other tools to get around a regional block.</li>
      <li>You may not use Chizzy if we have banned you, or to get around a restriction.</li>
    </ul>

    <h2>2. What Chizzy is</h2>
    <p>
      Chizzy connects you with a random adult stranger for a one-to-one video and text chat. You do not need an
      account. We do not record calls. Read the <Link to="/privacy">Privacy Policy</Link> to understand what data
      we handle, including how peer-to-peer calls share your IP address with your partner.
    </p>

    <h2>3. Rules</h2>
    <p>
      You must follow the <Link to="/guidelines">Community Guidelines</Link>. In short, you must not share, show or
      ask for:
    </p>
    <ul>
      <li>any sexual content involving a minor, or any contact with a minor of a sexual nature;</li>
      <li>nudity or sexual acts, or intimate images of anyone without their consent;</li>
      <li>harassment, threats, bullying or hate against a person or group;</li>
      <li>violence, self-harm encouragement, or illegal goods and services;</li>
      <li>spam, scams, advertising, or attempts to move people to other platforms for these purposes;</li>
      <li>pre-recorded, fake or impersonating video;</li>
      <li>content that breaks the law of India or of the country you are in, or that infringes someone's rights.</li>
    </ul>
    <p>You must not record, screenshot or redistribute other people's video without their consent.</p>

    <h2>4. Automated safety tools</h2>
    <p>
      Chizzy uses automated tools to reduce abuse: a bot check (Cloudflare Turnstile), on-device checks that can blur
      video that looks unsafe or hide your video when no face is visible, filters that hide links, handles and phone
      numbers in chat for the first minutes of a call, and rate limits. These tools make mistakes in both directions.
      They lower risk; they do not remove it.
    </p>

    <h2>5. Reports and enforcement</h2>
    <p>
      You can report a partner during a call or shortly after it. Reports and the material attached to them (one image
      from the call and recent chat lines) are reviewed by people on our team. Depending on what happened we may warn
      you or restrict your access: a warning, then pauses of 10 minutes, 24 hours and 7 days, then a permanent ban.
      Automated actions are limited to temporary pauses; a permanent ban is decided by a person. Serious cases, such as
      child sexual abuse material, may lead straight to a ban and a report to the authorities.
    </p>

    <h2>6. Appeals and grievances</h2>
    <p>
      You can appeal a restriction for free from the restriction screen. You can also raise a complaint with our{" "}
      <Link to="/grievance">Grievance Officer</Link>.
    </p>

    <h2>7. Your content</h2>
    <p>
      You are responsible for what you show and say. You keep any rights you have in it. You allow us to process it only
      as needed to run Chizzy and keep it safe (for example, to review a report).
    </p>

    <h2>8. Disclaimers and liability</h2>
    <p>
      Chizzy is provided "as is". You meet strangers at your own risk and should not share personal information. To the
      extent the law allows, our liability is limited to <Todo>liability cap to be set by the lawyer</Todo>.
    </p>

    <h2>9. Changes and ending</h2>
    <p>
      We may change these Terms. When we do, we will ask you to accept the new version before you continue. You may stop
      using Chizzy at any time. We may suspend or end access for anyone who breaks these Terms.
    </p>

    <h2>10. Governing law</h2>
    <p>
      These Terms are governed by the laws of India. Courts at <Todo>city</Todo> have jurisdiction, subject to any rights
      you have under the law of the country you live in.
    </p>

    <h2>11. Contact</h2>
    <p>
      <Todo>contact email address</Todo>
    </p>
  </LegalPage>
);

export default Terms;
