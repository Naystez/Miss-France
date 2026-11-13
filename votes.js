import {initializeApp} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import {
  getFirestore, collection, doc, getDocFromServer, getDocsFromServer, onSnapshot,
  writeBatch, setDoc, updateDoc, serverTimestamp, runTransaction
} from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';
import {firebaseConfig} from './firebase-config.js';
import {pointsForVote} from './scores.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const byId = id => document.getElementById(id);
const voteStatus = byId('vote-status');
const groupSelect = byId('vote-group');
const authForm = byId('vote-auth');
const ballot = byId('vote-ballot');
const resultsForm = byId('vote-results');
const resultsRef = doc(db, 'contest', 'results');
const candidates = [...document.querySelectorAll('#galerie .candidate')];
const candidateLabels = candidates.map(card =>
  card.querySelector('.region').textContent + ' · ' + card.querySelector('h3').textContent);
const rankLabels = ['Gagnante', '1ʳᵉ dauphine', '2ᵉ dauphine', '3ᵉ dauphine', '4ᵉ dauphine'];

function fillCandidates(select) {
  candidateLabels.forEach((label, index) => select.add(new Option(label, index + 1)));
}
function makeFields(container, labels) {
  return labels.map(title => {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.required = true;
    select.add(new Option('Choisir une candidate', ''));
    fillCandidates(select);
    label.append(title, select);
    container.append(label);
    return select;
  });
}
const voteFields = makeFields(byId('vote-choices'), [...rankLabels, 'Bonus · Miss qui trébuche']);
const resultFields = makeFields(byId('vote-result-top'), rankLabels);
const semiField = byId('vote-semi');
const tripsField = byId('vote-trips');
fillCandidates(semiField);
fillCandidates(tripsField);

let user;
let activeGroup;
let groupData;
let ownVote;
let results;
let votes = [];
let busy = false;
let sessionRevision = 0;
let groupRevision = 0;
let stopGroup = [];
let stopVotes = null;
let stopResults = null;

const membershipRef = (uid, group) => doc(db, 'users', uid, 'groups', group);
const groupRef = group => doc(db, 'groups', group);
const privateInviteRef = group => doc(db, 'groups', group, 'private', 'invite');
const voteRef = (group, uid) => doc(db, 'groups', group, 'votes', uid);
const inviteRef = token => doc(db, 'invites', token);
const message = text => { voteStatus.textContent = text; };

function describe(error) {
  return ({
    'permission-denied': 'Action refusée. Vérifie que ton compte a accès à ce groupe et que les votes sont ouverts.',
    'auth/invalid-credential': 'E-mail ou mot de passe incorrect.',
    'auth/email-already-in-use': 'Un compte utilise déjà cet e-mail. Connecte-toi.',
    'auth/operation-not-allowed': 'La connexion par e-mail doit être activée dans Firebase.',
    'auth/weak-password': 'Le mot de passe doit contenir au moins six caractères.',
    'auth/too-many-requests': 'Trop de tentatives. Réessaie dans quelques minutes.',
    'unavailable': 'Firebase est indisponible. Vérifie ta connexion puis réessaie.'
  })[error.code] || error.message || 'Une erreur est survenue.';
}

function act(handler) {
  return async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const control = event.submitter || (event.currentTarget.tagName === 'BUTTON' ? event.currentTarget : null);
    if (control) control.disabled = true;
    message('Traitement en cours…');
    try {
      await handler(event);
      if (voteStatus.textContent === 'Traitement en cours…') message('');
    } catch (error) {
      message(describe(error));
    } finally {
      busy = false;
      if (control) control.disabled = false;
    }
  };
}

function syncView() {
  const ready = Boolean(user?.emailVerified && groupData);
  byId('vote-group-panel').hidden = !ready;
  byId('vote-owner').hidden = !ready || groupData.owner !== user.uid;
  const closed = Boolean(groupData?.closed || results);
  byId('vote-close').disabled = closed;
  ballot.hidden = !ready || ownVote !== false || closed;
  byId('vote-reveal').hidden = !ready || !ownVote;
  byId('vote-group-name').textContent = groupData?.name || '';
  byId('vote-group-state').textContent = closed ? 'Votes fermés.' : 'Votes ouverts.';
  byId('vote-ranking-label').textContent = ready ? groupData.name : 'Choisis un groupe dans Pronostics.';
  renderContestRankings(ready && ownVote && results
    ? votes.map(vote => ({nom: vote.name, points: pointsForVote(vote, results)}))
    : []);
}

function renderVotes() {
  byId('vote-count').textContent = '(' + votes.length + ')';
  byId('vote-list').replaceChildren(...votes.map(vote => {
    const row = document.createElement('details');
    const title = document.createElement('summary');
    const list = document.createElement('ol');
    const bonus = document.createElement('p');
    title.textContent = vote.name;
    vote.top.forEach(candidate => {
      const line = document.createElement('li');
      line.textContent = candidateLabels[candidate - 1];
      list.append(line);
    });
    bonus.textContent = 'Bonus · ' + candidateLabels[vote.bonus - 1];
    row.append(title, list, bonus);
    return row;
  }));
}

function resetGroup() {
  groupRevision++;
  stopGroup.forEach(stop => stop());
  stopGroup = [];
  stopVotes?.();
  stopVotes = null;
  activeGroup = groupData = ownVote = null;
  votes = [];
  ballot.reset();
  byId('vote-invite').value = '';
  renderVotes();
  syncView();
}

function selectGroup(id) {
  resetGroup();
  if (!id || !user?.emailVerified) return;
  activeGroup = id;
  const revision = groupRevision;
  const uid = user.uid;
  const current = () => revision === groupRevision;
  const fail = error => { if (current()) message(describe(error)); };
  stopGroup.push(onSnapshot(groupRef(id), snapshot => {
    if (!current()) return;
    groupData = snapshot.data();
    syncView();
    if (groupData?.owner === uid) {
      getDocFromServer(privateInviteRef(id)).then(invite => {
        if (current() && invite.exists()) {
          const link = new URL(location.href);
          link.search = '';
          link.searchParams.set('invitation', invite.data().token);
          link.hash = 'pronostics';
          byId('vote-invite').value = link.href;
        }
      }).catch(fail);
    }
  }, fail));
  stopGroup.push(onSnapshot(voteRef(id, uid), {includeMetadataChanges: true}, snapshot => {
    if (!current() || snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
    ownVote = snapshot.exists() ? snapshot.data() : false;
    if (ownVote && !stopVotes) {
      stopVotes = onSnapshot(collection(db, 'groups', id, 'votes'), {includeMetadataChanges: true}, data => {
        if (!current() || data.metadata.fromCache) return;
        votes = data.docs.map(item => item.data()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
        renderVotes();
        syncView();
      }, fail);
    }
    syncView();
  }, fail));
}
groupSelect.addEventListener('change', () => selectGroup(groupSelect.value));

async function loadGroups(preferred) {
  const revision = sessionRevision;
  const uid = user.uid;
  const snapshots = await getDocsFromServer(collection(db, 'users', uid, 'groups'));
  const groups = await Promise.all(snapshots.docs.map(item => getDocFromServer(groupRef(item.id))));
  if (revision !== sessionRevision) return;
  const options = groups.filter(group => group.exists())
    .sort((a, b) => a.data().name.localeCompare(b.data().name, 'fr'));
  groupSelect.replaceChildren(new Option('Choisir un groupe', ''),
    ...options.map(group => new Option(group.data().name, group.id)));
  groupSelect.value = options.some(group => group.id === preferred) ? preferred : options[0]?.id || '';
  selectGroup(groupSelect.value);
}

async function startSession(account) {
  const revision = ++sessionRevision;
  stopResults?.();
  stopResults = null;
  user = account;
  results = null;
  resetGroup();
  authForm.hidden = Boolean(user);
  byId('vote-session').hidden = !user;
  byId('vote-groups').hidden = !user?.emailVerified;
  resultsForm.hidden = true;
  byId('vote-email').textContent = user?.email || '';
  byId('vote-check').hidden = byId('vote-resend').hidden = !user || user.emailVerified;
  if (!user) { message('Connecte-toi pour rejoindre ou créer un groupe.'); return; }
  if (!user.emailVerified) { message('Vérifie ton adresse e-mail pour accéder aux groupes.'); return; }
  message('');
  stopResults = onSnapshot(resultsRef, snapshot => {
    if (revision !== sessionRevision) return;
    results = snapshot.exists() ? snapshot.data() : null;
    syncView();
  }, error => { if (revision === sessionRevision) message(describe(error)); });
  await loadGroups();
  const admin = await getDocFromServer(doc(db, 'admins', account.uid));
  if (revision === sessionRevision) resultsForm.hidden = admin.data()?.active !== true;
}

onAuthStateChanged(auth, account => startSession(account).catch(error => message(describe(error))));
const inviteInput = byId('vote-join').elements.invite;
const invitation = new URLSearchParams(location.search).get('invitation');
if (invitation && /^[0-9a-f]{48}$/.test(invitation)) inviteInput.value = invitation;

authForm.addEventListener('submit', act(async event => {
  const email = authForm.elements.email.value.trim();
  const password = authForm.elements.password.value;
  if (event.submitter?.value === 'register') {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(credential.user);
    message('E-mail de vérification envoyé.');
  } else {
    await signInWithEmailAndPassword(auth, email, password);
  }
  authForm.elements.password.value = '';
}));
byId('vote-check').addEventListener('click', act(async () => {
  await user.reload();
  await user.getIdToken(true);
  await startSession(auth.currentUser);
}));
byId('vote-resend').addEventListener('click', act(async () => {
  await sendEmailVerification(user);
  message('E-mail de vérification envoyé.');
}));
byId('vote-reset').addEventListener('click', act(async () => {
  const email = authForm.elements.email;
  if (!email.value || !email.reportValidity()) { email.focus(); return; }
  await sendPasswordResetEmail(auth, email.value.trim());
  message('Si ce compte existe, tu recevras un lien de réinitialisation.');
}));
byId('vote-signout').addEventListener('click', act(() => signOut(auth)));

function makeInvite(batch, group) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte =>
    byte.toString(16).padStart(2, '0')).join('');
  batch.set(inviteRef(token), {group});
  batch.set(privateInviteRef(group), {token});
  return token;
}
byId('vote-create').addEventListener('submit', act(async event => {
  const form = event.currentTarget;
  const name = form.elements.groupName.value.trim();
  if (!name) throw new Error('Donne un nom à ton groupe.');
  const group = doc(collection(db, 'groups'));
  const batch = writeBatch(db);
  batch.set(group, {name, owner: user.uid, closed: false});
  batch.set(membershipRef(user.uid, group.id), {joined: true});
  makeInvite(batch, group.id);
  await batch.commit();
  form.reset();
  await loadGroups(group.id);
  message('Groupe créé. Son lien d’invitation est prêt à partager.');
}));
byId('vote-join').addEventListener('submit', act(async () => {
  let token = inviteInput.value.trim();
  if (token.includes('://')) token = new URL(token).searchParams.get('invitation') || '';
  if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('Lien ou code d’invitation invalide.');
  const invite = await getDocFromServer(inviteRef(token)).catch(error => {
    if (error.code === 'permission-denied') throw new Error('Cette invitation est invalide ou a été renouvelée.');
    throw error;
  });
  const group = invite.data()?.group;
  if (!group) throw new Error('Cette invitation est introuvable.');
  const ref = membershipRef(user.uid, group);
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (!existing.exists()) transaction.set(ref, {token});
  });
  inviteInput.value = '';
  const url = new URL(location.href);
  url.searchParams.delete('invitation');
  history.replaceState(null, '', url);
  await loadGroups(group);
  message('Groupe rejoint.');
}));
byId('vote-copy').addEventListener('click', act(async () => {
  const field = byId('vote-invite');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    message('Lien copié.');
  } catch {
    field.focus();
    field.select();
    message('Le lien est sélectionné. Copie-le pour le partager.');
  }
}));
byId('vote-rotate').addEventListener('click', act(async () => {
  if (!confirm('Remplacer le lien actuel ? Les membres déjà inscrits gardent leur accès.')) return;
  const group = activeGroup;
  const batch = writeBatch(db);
  const token = makeInvite(batch, group);
  await batch.commit();
  if (activeGroup === group) {
    const link = new URL(location.href);
    link.search = '';
    link.searchParams.set('invitation', token);
    link.hash = 'pronostics';
    byId('vote-invite').value = link.href;
  }
  message('Lien renouvelé.');
}));
byId('vote-close').addEventListener('click', act(async () => {
  if (!confirm('Fermer définitivement les votes de ce groupe ?')) return;
  await updateDoc(groupRef(activeGroup), {closed: true});
  message('Votes fermés.');
}));

function readTop(fields) {
  const top = fields.map(field => Number(field.value));
  if (top.includes(0) || new Set(top).size !== 5) throw new Error('Choisis cinq candidates différentes.');
  return top;
}
ballot.addEventListener('submit', act(async () => {
  const group = activeGroup;
  const name = ballot.elements.alias.value.trim();
  if (!name) throw new Error('Renseigne ton nom affiché.');
  const top = readTop(voteFields.slice(0, 5));
  const bonus = Number(voteFields[5].value);
  if (!bonus) throw new Error('Choisis une candidate pour le bonus.');
  const summary = top.map((id, index) => rankLabels[index] + ' · ' + candidateLabels[id - 1]).join('\n');
  if (!confirm(summary + '\nBonus · ' + candidateLabels[bonus - 1] + '\n\nValider définitivement ce pronostic ?')) return;
  await setDoc(voteRef(group, user.uid), {name, top, bonus, createdAt: serverTimestamp()});
  message('Ton pronostic est enregistré et verrouillé.');
}));
resultsForm.addEventListener('submit', act(async () => {
  const top = readTop(resultFields);
  const semi = [...new Set([...top, ...Array.from(semiField.selectedOptions, item => Number(item.value))])];
  const trips = Array.from(tripsField.selectedOptions, item => Number(item.value));
  if (!confirm('Publier les résultats et fermer les votes dans tous les groupes ?')) return;
  await setDoc(resultsRef, {top, semi, trips});
  message('Résultats publiés pour tous les groupes.');
}));
