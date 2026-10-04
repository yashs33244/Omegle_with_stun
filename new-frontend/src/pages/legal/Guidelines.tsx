import { Link } from "react-router-dom";
import { LegalPage } from "./LegalPage";

const Guidelines = () => (
  <LegalPage title="Community Guidelines">
    <p>
      Chizzy works when strangers can trust that the next person is an adult who is there to talk. These rules apply in
      every call and every chat. This page is also our regular reminder of the rules.
    </p>

    <h2>The rules</h2>
    <ol>
      <li>
        <strong>18+ only.</strong> If you think your partner is under 18, end the call and report them as "Underage".
      </li>
      <li>
        <strong>Keep your clothes on.</strong> No nudity, sexual acts or sexual requests on camera or in chat.
      </li>
      <li>
        <strong>Nothing sexual involving minors, ever.</strong> We report child sexual abuse material to the authorities.
      </li>
      <li>
        <strong>Be respectful.</strong> No harassment, threats, bullying or hate based on who someone is.
      </li>
      <li>
        <strong>No violence or gore,</strong> and do not encourage self-harm.
      </li>
      <li>
        <strong>No spam or scams.</strong> No advertising, selling, links to adult sites, or asking people to move to
        another app to send money or images.
      </li>
      <li>
        <strong>Be real.</strong> No pre-recorded, looped or fake video, and do not pretend to be someone else.
      </li>
      <li>
        <strong>Respect privacy.</strong> Do not record or screenshot people, and do not share anyone's personal details.
      </li>
      <li>
        <strong>Follow the law</strong> where you are and in India.
      </li>
    </ol>

    <h2>What happens if someone breaks the rules</h2>
    <p>Reports are reviewed by people on our team. Depending on what happened, the steps are:</p>
    <ol>
      <li>a warning,</li>
      <li>a 10 minute pause,</li>
      <li>a 24 hour pause,</li>
      <li>a 7 day pause,</li>
      <li>a permanent ban (only decided by a person).</li>
    </ol>
    <p>
      Serious cases can skip steps. A report on its own leads at most to a temporary pause until a person reviews it.
      You can appeal any restriction for free from the restriction screen.
    </p>

    <h2>Stay safe</h2>
    <ul>
      <li>Do not share your name, school, workplace, address, phone number or social media handles.</li>
      <li>If someone threatens to share images of you, do not pay and stop replying. See our <Link to="/safety">Safety page</Link>.</li>
      <li>Use Next or Report as soon as something feels wrong.</li>
    </ul>
  </LegalPage>
);

export default Guidelines;
