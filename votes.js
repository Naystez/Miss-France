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
const joinTab = byId('vote-tab-join');
const groupTab = byId('vote-tab-group');

function showVoteView(view) {
  const showingGroup = view === 'group';
  joinTab.setAttribute('aria-pressed', String(!showingGroup));
  groupTab.setAttribute('aria-pressed', String(showingGroup));
  byId('vote-join-view').hidden = showingGroup;
  byId('vote-group-view').hidden = !showingGroup;
}
joinTab.addEventListener('click', () => showVoteView('join'));
groupTab.addEventListener('click', () => showVoteView('group'));
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
let draft = null;
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
  const canVote = ready && ownVote === false && !closed;
  if (!canVote) draft = null;
  ballot.hidden = !canVote || Boolean(draft);
  byId('vote-review').hidden = !canVote || !draft;
  byId('vote-own').hidden = !ready || !ownVote;
  byId('vote-own-group').textContent = groupData?.name || '';
  byId('vote-review-group').textContent = groupData?.name || '';
  byId('vote-reveal').hidden = !ready || !ownVote;
  byId('vote-group-name').textContent = groupData?.name || '';
  byId('vote-group-state').textContent = closed ? 'Votes fermés.' : 'Votes ouverts.';
  byId('vote-ranking-label').textContent = ready ? groupData.name : 'Choisis un groupe dans Pronostics.';
  renderContestRankings(ready && ownVote && results
    ? votes.map(vote => ({nom: vote.name, points: pointsForVote(vote, results)}))
    : []);
}

function renderPicks(vote) {
  const list = document.createElement('ul');
  list.className = 'vote-picks';
  [...vote.top, vote.bonus].forEach((candidate, index) => {
    const pick = document.createElement('li');
    const info = document.createElement('div');
    const rank = document.createElement('small');
    const region = document.createElement('strong');
    const card = candidates[candidate - 1];
    const image = card.querySelector('.photo-open img').cloneNode();
    pick.className = 'vote-pick';
    image.alt = '';
    image.loading = 'lazy';
    rank.textContent = rankLabels[index] || 'Bonus';
    region.textContent = candidateLabels[candidate - 1];
    info.append(rank, region);
    pick.append(image, info);
    list.append(pick);
  });
  return list;
}

function renderVotes() {
  const others = votes.filter(vote => vote.uid !== user?.uid);
  const list = byId('vote-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map(row => row.dataset.uid));
  byId('vote-count').textContent = '(' + others.length + ')';
  byId('vote-other-empty').hidden = others.length > 0;
  list.replaceChildren(...others.map(vote => {
    const row = document.createElement('details');
    const summary = document.createElement('summary');
    const name = document.createElement('strong');
    const winner = document.createElement('small');
    row.className = 'vote-member';
    row.dataset.uid = vote.uid;
    row.open = open.has(vote.uid);
    name.textContent = vote.name;
    winner.textContent = 'Gagnante · ' + candidateLabels[vote.top[0] - 1];
    summary.append(name, winner);
    row.append(summary, renderPicks(vote));
    return row;
  }));
}

function resetGroup() {
  groupRevision++;
  stopGroup.forEach(stop => stop());
  stopGroup = [];
  stopVotes?.();
  stopVotes = null;
  activeGroup = groupData = ownVote = draft = null;
  byId('vote-own-picks').replaceChildren();
  byId('vote-review-status').textContent = '';
  votes = [];
  ballot.reset();
  byId('vote-invite').value = '';
  byId('vote-owner').open = false;
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
          byId('vote-invite').value = invite.data().token;
        }
      }).catch(fail);
    }
  }, fail));
  stopGroup.push(onSnapshot(voteRef(id, uid), {includeMetadataChanges: true}, snapshot => {
    if (!current() || snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
    ownVote = snapshot.exists() ? snapshot.data() : false;
    if (ownVote) byId('vote-own-picks').replaceChildren(renderPicks(ownVote));
    if (ownVote && !stopVotes) {
      stopVotes = onSnapshot(collection(db, 'groups', id, 'votes'), {includeMetadataChanges: true}, data => {
        if (!current() || data.metadata.fromCache) return;
        votes = data.docs.map(item => ({...item.data(), uid: item.id})).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
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
  const hasGroups = options.length > 0;
  groupSelect.disabled = !hasGroups;
  byId('vote-no-group').hidden = hasGroups;
  selectGroup(groupSelect.value);
  showVoteView((hasGroups && !inviteInput.value) ? 'group' : 'join');
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
  showVoteView('group');
  byId('vote-owner').open = true;
  message('Groupe créé. Copie le code pour inviter des participants.');
}));
byId('vote-join').addEventListener('submit', act(async () => {
  const token = inviteInput.value.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('Code d’invitation invalide.');
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
  showVoteView('group');
  message('Groupe rejoint.');
}));
byId('vote-copy').addEventListener('click', act(async () => {
  const field = byId('vote-invite');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    message('Code copié.');
  } catch {
    field.focus();
    field.select();
    message('Le code est sélectionné. Copie-le pour le partager.');
  }
}));
byId('vote-rotate').addEventListener('click', act(async () => {
  if (!confirm('Remplacer le code actuel ? Les membres déjà inscrits gardent leur accès.')) return;
  const group = activeGroup;
  const batch = writeBatch(db);
  const token = makeInvite(batch, group);
  await batch.commit();
  if (activeGroup === group) {
    byId('vote-invite').value = token;
  }
  message('Code renouvelé.');
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
  const name = ballot.elements.alias.value.trim();
  if (!name) throw new Error('Renseigne ton nom affiché.');
  const top = readTop(voteFields.slice(0, 5));
  const bonus = Number(voteFields[5].value);
  if (!bonus) throw new Error('Choisis une candidate pour le bonus.');
  draft = {name, top, bonus};
  byId('vote-review-picks').replaceChildren(renderPicks(draft));
  byId('vote-review-status').textContent = '';
  syncView();
  byId('vote-review-title').focus();
}));
byId('vote-review-back').addEventListener('click', () => {
  if (busy) return;
  draft = null;
  syncView();
  ballot.querySelector('button[type="submit"],button').focus();
});
byId('vote-review-confirm').addEventListener('click', act(async () => {
  if (!draft || ownVote !== false || groupData?.closed || results) return;
  const submitted = draft;
  const revision = groupRevision;
  byId('vote-review-status').textContent = 'Enregistrement…';
  try {
    await setDoc(voteRef(activeGroup, user.uid), {...submitted, createdAt: serverTimestamp()});
  } catch (error) {
    if (revision === groupRevision) byId('vote-review-status').textContent = describe(error);
    throw error;
  }
  if (revision !== groupRevision) return;
  ownVote = submitted;
  byId('vote-own-picks').replaceChildren(renderPicks(ownVote));
  syncView();
  byId('vote-own-title').focus();
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

onAuthStateChanged(auth, account => startSession(account).catch(error => message(describe(error))));
