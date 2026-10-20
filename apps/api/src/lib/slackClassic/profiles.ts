// Verbatim port of the profile/name helpers in wordhop-slack slack_bot.js +
// transcript_api.js. These produce the usernames/avatars on transcript lines
// and the `j-{name}` channel names — parity requires identical output.

export interface ClassicUserProfile {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  image?: string;
  icon_emoji?: string;
  gender?: string;
  timezone?: string;
  locale?: string;
  email?: string;
  phone?: string;
  address?: string;
  emails?: unknown;
  language?: string;
  teamid?: string;
  [k: string]: unknown;
}

// getUsername (slack_bot.js ~7751)
export function getUsername(profile: any, isBot?: boolean): string {
  if (profile?.profile && (profile.profile.team || profile.profile.id || profile.profile.name)) {
    profile = profile.profile;
  }
  let name = isBot ? 'Bot' : 'User';
  if (profile?.displayName) {
    name = profile.displayName;
  } else if (profile?.name) {
    name = profile.name;
    if (profile.name.givenName) name = profile.name.givenName;
    if (profile.name.familyName) name = `${name} ${profile.name.familyName}`;
  } else if (profile?.first_name) {
    name = profile.first_name;
    if (profile.last_name) name = `${name} ${profile.last_name}`;
    name = name.charAt(0).toUpperCase() + name.slice(1);
  } else if (profile?.last_name) {
    name = profile.last_name;
    name = name.charAt(0).toUpperCase() + name.slice(1);
  } else if (profile?.real_name_normalized) {
    name = profile.real_name_normalized;
  } else if (profile?.real_name) {
    name = profile.real_name;
  } else if (profile?.display_name_normalized) {
    name = profile.display_name_normalized;
  } else if (profile?.display_name) {
    name = profile.display_name;
  } else if (profile?.id) {
    name = profile.id;
  }
  return name;
}

// getUserProfile (slack_bot.js ~7787) — normalizes any legacy user payload
// into {name, image, icon_emoji, …}; strips null/empty keys like the original.
export function getUserProfile(user: any, isBot?: boolean): ClassicUserProfile {
  if (user == null) user = {};
  let icon = ':bust_in_silhouette:';
  if (isBot) icon = ':robot_face:';
  const profile = user.profile || user.user_profile;
  const userProfile = profile && (profile.team || profile.id) ? profile : user;
  let userid = user.id;
  if (userid == null && userProfile.id) userid = userProfile.id;
  let teamid: string | undefined;
  if (userProfile.team) {
    teamid = userProfile.team.id || userProfile.team;
    if (userid == null) userid = teamid;
  }
  if (userid == null) userid = isBot ? 'bot' : 'user';

  if (userProfile.gender) {
    if (userProfile.gender === 'male') icon = ':boy:';
    else icon = ':information_desk_person:';
  }
  let iconUrl = `https://avatars.dicebear.com/api/big-smile/${userid}.svg`;
  if (isBot) {
    iconUrl =
      user.name === 'Janis'
        ? `${process.env.JANIS_WEBAPP_URL ?? 'https://www.janis.ai'}/img/favicon.jpg`
        : 'https://cdn.pixabay.com/photo/2017/10/24/00/39/bot-icon-2883144_1280.png';
  }
  const p = userProfile;
  iconUrl =
    p.profile_pic ||
    p.image?.url ||
    p.image ||
    p.image_512 ||
    p.image_192 ||
    p.image_72 ||
    p.image_48 ||
    (p.profile && p.profile.image_48) ||
    iconUrl;

  const updated: ClassicUserProfile = {
    id: userid,
    name: getUsername(userProfile, isBot),
    first_name: p.first_name,
    last_name: p.last_name,
    image: iconUrl,
    icon_emoji: icon,
    gender: p.gender,
    timezone: p.timezone || user.tz_label || user.tz || user.tz_offset,
    locale: p.locale || p.language,
    email: p.email,
    phone: p.phone,
    address: p.address,
    emails: p.emails,
    language: p.language,
    teamid,
  };
  const filtered = Object.fromEntries(
    Object.entries(updated).filter(([, v]) => v != null && v !== ''),
  );
  return filtered as ClassicUserProfile;
}

function sanitizeSlackName(s: string): string {
  return s
    .replace(' ', '-')
    .replace(/[.,/!$%^&*;:{}=\-_`~()#]/g, '-')
    .toLowerCase();
}

// getUserName (transcript_api.js ~67) — the j-channel username candidate.
export function getUserName(p: any): string | undefined {
  let username: string | undefined;
  const userProfile = p && p.profile && p.profile.id ? p.profile : p;
  if (userProfile) {
    if (userProfile.real_name_normalized) username = userProfile.real_name_normalized;
    else if (userProfile.real_name) username = userProfile.real_name;
    else if (userProfile.first_name) {
      username = userProfile.first_name;
      if (userProfile.last_name) username = `${username}-${userProfile.last_name}`;
    } else if (userProfile.name) username = userProfile.name;
    else if (userProfile.last_name) username = userProfile.last_name;
  }
  if (username) username = sanitizeSlackName(username);
  return username;
}

// suggestedChannelName (transcript_api.js ~44)
export function suggestedChannelName(
  sourceChannel: string,
  userProfile: any,
): { name: string; isUsernameFound: boolean } {
  let username = getUserName(userProfile);
  const isUsernameFound = !!username;
  if (!username) username = sourceChannel;
  username = sanitizeSlackName(username);
  return { name: `j-${username}`, isUsernameFound };
}

// removeFormatting (slack_bot.js ~6151) — strips Slack markup before relaying
// operator text to the customer.
const RESERVED = ['channel', 'group', 'everyone', 'here'];
export function removeFormatting<T extends { text?: string }>(msg: T | string): T | string {
  const isString = typeof msg === 'string';
  const text = isString ? (msg as string) : (msg.text ?? '');
  let out = text;
  if (out) {
    out = out.replace(/<([@#!])?([^>|]+)(?:\|([^>]+))?>/g, (m, type, link, label) => {
      switch (type) {
        case '@':
          return m;
        case '#':
          return label || '';
        case '!':
          return RESERVED.includes(link) ? `@${link}` : '';
        default: {
          link = String(link).replace(/^mailto:/, '');
          if (label && link.indexOf(label) === -1) return `${label} (${link})`;
          return link;
        }
      }
    });
  }
  if (isString) return out;
  msg.text = out;
  const inner = (msg as any).message;
  if (inner) inner.text = out;
  return msg;
}
