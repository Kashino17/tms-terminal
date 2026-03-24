import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'tms:credentials';

// ── Types ────────────────────────────────────────────────────────────────────
export type FieldType =
  | 'username' | 'password' | 'email' | 'phone'
  | 'firstName' | 'lastName' | 'company'
  | 'street' | 'zip' | 'city' | 'country'
  | 'address' | 'name'
  | 'custom';

export const FIELD_DEFS: Record<FieldType, { label: string; icon: string }> = {
  username:  { label: 'Benutzername', icon: 'user' },
  password:  { label: 'Passwort',     icon: 'lock' },
  email:     { label: 'E-Mail',       icon: 'mail' },
  phone:     { label: 'Telefon',      icon: 'phone' },
  firstName: { label: 'Vorname',      icon: 'user' },
  lastName:  { label: 'Nachname',     icon: 'user' },
  company:   { label: 'Firma',        icon: 'briefcase' },
  street:    { label: 'Straße',       icon: 'map-pin' },
  zip:       { label: 'PLZ',          icon: 'hash' },
  city:      { label: 'Stadt',        icon: 'home' },
  country:   { label: 'Land',         icon: 'globe' },
  address:   { label: 'Adresse',      icon: 'map-pin' },
  name:      { label: 'Name (voll)',  icon: 'type' },
  custom:    { label: 'Custom',       icon: 'edit-3' },
};

export const FIELD_TYPE_LIST: FieldType[] = [
  'username', 'password', 'email', 'phone',
  'firstName', 'lastName', 'company',
  'street', 'zip', 'city', 'country',
  'address', 'name', 'custom',
];

export interface CredentialField {
  id: string;
  type: FieldType;
  label: string;
  value: string;
}

export interface Credential {
  id: string;
  label: string;
  urlPattern: string; // e.g. ":3000", ":3000/login", "*"
  fields: CredentialField[];
}

// ── URL matching ─────────────────────────────────────────────────────────────
export function matchesUrl(pattern: string, url: string): boolean {
  if (!pattern || pattern === '*') return true;
  try {
    const parsed = new URL(url);
    const portPath = `:${parsed.port}${parsed.pathname.replace(/\/+$/, '')}`;
    const portOnly = `:${parsed.port}`;
    if (pattern.startsWith(':')) {
      const clean = pattern.replace(/\/+$/, '');
      return portPath.startsWith(clean) || portOnly === clean;
    }
    return url.toLowerCase().includes(pattern.toLowerCase());
  } catch {
    return false;
  }
}

// ── Autofill JS builder ──────────────────────────────────────────────────────
const SELECTORS: Record<FieldType, string[]> = {
  email:     ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[autocomplete="email"]'],
  password:  ['input[type="password"]'],
  username:  ['input[name*="user" i]', 'input[id*="user" i]', 'input[name*="login" i]', 'input[autocomplete="username"]'],
  phone:     ['input[type="tel"]', 'input[name*="phone" i]', 'input[name*="tel" i]', 'input[id*="phone" i]', 'input[autocomplete="tel"]'],
  firstName: [
    'input[autocomplete="given-name"]', 'input[autocomplete="first-name"]',
    'input[name*="first" i][name*="name" i]', 'input[name*="vorname" i]',
    'input[id*="first" i][id*="name" i]', 'input[id*="vorname" i]',
    'input[name="firstName"]', 'input[name="fname"]', 'input[name="first_name"]',
    'input[placeholder*="Vorname" i]', 'input[placeholder*="First" i]',
  ],
  lastName: [
    'input[autocomplete="family-name"]', 'input[autocomplete="last-name"]',
    'input[name*="last" i][name*="name" i]', 'input[name*="nachname" i]', 'input[name*="surname" i]',
    'input[id*="last" i][id*="name" i]', 'input[id*="nachname" i]',
    'input[name="lastName"]', 'input[name="lname"]', 'input[name="last_name"]',
    'input[placeholder*="Nachname" i]', 'input[placeholder*="Last" i]',
  ],
  company: [
    'input[autocomplete="organization"]',
    'input[name*="company" i]', 'input[name*="firma" i]', 'input[name*="organization" i]', 'input[name*="organisation" i]',
    'input[id*="company" i]', 'input[id*="firma" i]',
    'input[placeholder*="Firma" i]', 'input[placeholder*="Company" i]', 'input[placeholder*="Unternehmen" i]',
  ],
  street: [
    'input[autocomplete="street-address"]', 'input[autocomplete="address-line1"]',
    'input[name*="street" i]', 'input[name*="strasse" i]', 'input[name*="straße" i]', 'input[name*="address1" i]', 'input[name*="address_line" i]',
    'input[id*="street" i]', 'input[id*="strasse" i]',
    'input[placeholder*="Straße" i]', 'input[placeholder*="Street" i]', 'input[placeholder*="Adresse" i]',
  ],
  zip: [
    'input[autocomplete="postal-code"]',
    'input[name*="zip" i]', 'input[name*="postal" i]', 'input[name*="plz" i]', 'input[name*="postcode" i]',
    'input[id*="zip" i]', 'input[id*="postal" i]', 'input[id*="plz" i]',
    'input[placeholder*="PLZ" i]', 'input[placeholder*="Postleitzahl" i]', 'input[placeholder*="ZIP" i]',
    'input[inputmode="numeric"][maxlength="5"]',
  ],
  city: [
    'input[autocomplete="address-level2"]',
    'input[name*="city" i]', 'input[name*="stadt" i]', 'input[name*="ort" i]', 'input[name*="town" i]',
    'input[id*="city" i]', 'input[id*="stadt" i]', 'input[id*="ort" i]',
    'input[placeholder*="Stadt" i]', 'input[placeholder*="City" i]', 'input[placeholder*="Ort" i]',
  ],
  country: [
    'input[autocomplete="country-name"]', 'input[autocomplete="country"]', 'select[autocomplete="country"]',
    'input[name*="country" i]', 'input[name*="land" i]:not([name*="bundesland" i])',
    'select[name*="country" i]', 'select[name*="land" i]:not([name*="bundesland" i])',
    'input[id*="country" i]', 'select[id*="country" i]',
    'input[placeholder*="Land" i]', 'input[placeholder*="Country" i]',
  ],
  name:      [
    'input[autocomplete="name"]', 'input[autocomplete="cc-name"]',
    'input[name="name"]', 'input[name*="fullname" i]', 'input[name*="full_name" i]',
    'input[id="name"]',
  ],
  address:   [
    'input[autocomplete="street-address"]',
    'input[name*="address" i]:not([name*="email" i])', 'input[id*="address" i]:not([id*="email" i])',
    'textarea[name*="address" i]',
  ],
  custom:    [],
};

export function buildAutofillJS(fields: CredentialField[]): string {
  const entries = fields
    .filter((f) => f.value)
    .map((f) => {
      let sels = SELECTORS[f.type] ?? [];
      if (f.type === 'custom' && f.label) {
        const l = f.label.toLowerCase();
        sels = [`input[name*="${l}"]`, `input[id*="${l}"]`, `input[placeholder*="${l}"]`, `textarea[name*="${l}"]`];
      }
      return { sels, value: f.value };
    })
    .filter((e) => e.sels.length > 0);

  if (entries.length === 0) return '';

  const cmds = entries
    .map((e) => `fill(${JSON.stringify(e.sels)},${JSON.stringify(e.value)});`)
    .join('');

  return `(function(){
function fill(ss,v){for(var i=0;i<ss.length;i++){var els=document.querySelectorAll(ss[i]);
for(var j=0;j<els.length;j++){var el=els[j];
if(el.tagName==='SELECT'){el.value=v;el.dispatchEvent(new Event('change',{bubbles:true}));continue}
var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
var d=Object.getOwnPropertyDescriptor(p,'value');
if(d&&d.set){d.set.call(el,v)}else{el.value=v}
el.dispatchEvent(new Event('input',{bubbles:true}));
el.dispatchEvent(new Event('change',{bubbles:true}));
}}}
${cmds}
window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'__autofill__',ok:true}));
true;})();`;
}

// ── Form detection JS (injected into WebViews) ──────────────────────────────
export const FORM_DETECT_JS = `
(function(){
  if (!window.ReactNativeWebView) return;
  var _post = window.ReactNativeWebView.postMessage.bind(window.ReactNativeWebView);
  var _sent = false;
  function detect() {
    if (_sent) return;
    var f = [];
    if (document.querySelector('input[type="password"]')) f.push('password');
    if (document.querySelector('input[type="email"],input[name*="email" i],input[id*="email" i]')) f.push('email');
    if (document.querySelector('input[type="tel"],input[name*="phone" i],input[name*="tel" i]')) f.push('phone');
    if (document.querySelector('input[name*="user" i],input[id*="user" i],input[name*="login" i]')) f.push('username');
    if (document.querySelector('input[autocomplete="given-name"],input[name*="vorname" i],input[name*="first" i]')) f.push('firstName');
    if (document.querySelector('input[autocomplete="family-name"],input[name*="nachname" i],input[name*="last" i]')) f.push('lastName');
    if (document.querySelector('input[name*="company" i],input[name*="firma" i],input[autocomplete="organization"]')) f.push('company');
    if (document.querySelector('input[name*="street" i],input[name*="strasse" i],input[autocomplete="street-address"]')) f.push('street');
    if (document.querySelector('input[name*="zip" i],input[name*="plz" i],input[name*="postal" i],input[autocomplete="postal-code"]')) f.push('zip');
    if (document.querySelector('input[name*="city" i],input[name*="stadt" i],input[name*="ort" i],input[autocomplete="address-level2"]')) f.push('city');
    if (document.querySelector('input[name*="address" i],textarea[name*="address" i]')) f.push('address');
    if (f.length > 0) {
      _sent = true;
      _post(JSON.stringify({ type: '__form_detected__', fields: f }));
    }
  }
  setTimeout(detect, 800);
  if (document.body) {
    new MutationObserver(function() {
      clearTimeout(window.__tmsFormTimer);
      window.__tmsFormTimer = setTimeout(detect, 500);
    }).observe(document.body, { childList: true, subtree: true });
  }
  true;
})();`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function save(serverId: string, creds: Credential[]) {
  AsyncStorage.setItem(`${STORAGE_KEY}:${serverId}`, JSON.stringify(creds)).catch(() => {});
}

// ── Store ────────────────────────────────────────────────────────────────────
interface CredentialState {
  credentials: Record<string, Credential[]>;
  loaded: Record<string, boolean>;
  load: (serverId: string) => Promise<void>;
  getAll: (serverId: string) => Credential[];
  getForUrl: (serverId: string, url: string) => Credential[];
  addCredential: (serverId: string, urlPattern?: string) => string;
  removeCredential: (serverId: string, credId: string) => void;
  updateCredential: (serverId: string, credId: string, updates: Partial<Pick<Credential, 'label' | 'urlPattern'>>) => void;
  addField: (serverId: string, credId: string, type?: FieldType) => void;
  removeField: (serverId: string, credId: string, fieldId: string) => void;
  updateField: (serverId: string, credId: string, fieldId: string, updates: Partial<Pick<CredentialField, 'label' | 'value' | 'type'>>) => void;
}

export const useCredentialStore = create<CredentialState>((set, get) => ({
  credentials: {},
  loaded: {},

  async load(serverId) {
    if (get().loaded[serverId]) return;
    try {
      const raw = await AsyncStorage.getItem(`${STORAGE_KEY}:${serverId}`);
      const creds: Credential[] = raw ? JSON.parse(raw) : [];
      set((s) => ({
        credentials: { ...s.credentials, [serverId]: creds },
        loaded: { ...s.loaded, [serverId]: true },
      }));
    } catch {
      set((s) => ({
        credentials: { ...s.credentials, [serverId]: [] },
        loaded: { ...s.loaded, [serverId]: true },
      }));
    }
  },

  getAll: (serverId) => get().credentials[serverId] ?? [],

  getForUrl(serverId, url) {
    return (get().credentials[serverId] ?? []).filter((c) => matchesUrl(c.urlPattern, url));
  },

  addCredential(serverId, urlPattern = ':3000') {
    const id = makeId();
    const cred: Credential = {
      id,
      label: 'Neues Login',
      urlPattern,
      fields: [
        { id: makeId(), type: 'email', label: 'E-Mail', value: '' },
        { id: makeId(), type: 'password', label: 'Passwort', value: '' },
      ],
    };
    set((s) => {
      const list = [...(s.credentials[serverId] ?? []), cred];
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
    return id;
  },

  removeCredential(serverId, credId) {
    set((s) => {
      const list = (s.credentials[serverId] ?? []).filter((c) => c.id !== credId);
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
  },

  updateCredential(serverId, credId, updates) {
    set((s) => {
      const list = (s.credentials[serverId] ?? []).map((c) =>
        c.id === credId ? { ...c, ...updates } : c,
      );
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
  },

  addField(serverId, credId, type = 'custom') {
    const def = FIELD_DEFS[type];
    set((s) => {
      const list = (s.credentials[serverId] ?? []).map((c) => {
        if (c.id !== credId) return c;
        return { ...c, fields: [...c.fields, { id: makeId(), type, label: def.label, value: '' }] };
      });
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
  },

  removeField(serverId, credId, fieldId) {
    set((s) => {
      const list = (s.credentials[serverId] ?? []).map((c) => {
        if (c.id !== credId) return c;
        return { ...c, fields: c.fields.filter((f) => f.id !== fieldId) };
      });
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
  },

  updateField(serverId, credId, fieldId, updates) {
    set((s) => {
      const list = (s.credentials[serverId] ?? []).map((c) => {
        if (c.id !== credId) return c;
        return { ...c, fields: c.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)) };
      });
      save(serverId, list);
      return { credentials: { ...s.credentials, [serverId]: list } };
    });
  },
}));
