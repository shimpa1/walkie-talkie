# User guide

Use walkie-talkie to read your firstmate's work and send instructions from a
phone or desktop browser. The app is an installable website; no native binary
is required. The [documentation index](README.md) explains which features are
enabled on atus.

## Sign in and install

For the atus gateway, open `https://walkie-talkie.atus.hr` and choose **Sign in
with GitHub**. Use the account the admin invited or approved. You may already
be admitted if your numeric GitHub id is declared by the operator.

If you have no invitation, signing in requests access when requests are
enabled. The app says approval is pending. Approval does not sign you in
automatically: sign in again after the admin approves. A denied or suspended
account cannot sign in. Ask the admin if access remains unavailable.

A session belongs to this browser/device. It expires after 30 days without
use or 90 days from issuance. Sign in again when it expires. GitHub sign-in
identifies you; it does not give firstmate repository permissions. The optional
GitHub token in Setup is a separate credential.

On iPhone or iPad:

1. Open the HTTPS site in Safari.
2. Use Share → **Add to Home Screen** and launch the installed app.
3. Sign in from the app. If OAuth returns to Safari and leaves the installed
   app signed out, link the app from the signed-in Safari window as below.
4. For push, enable notifications from the installed app, not a Safari tab.
   The app's supported iOS/iPadOS push path requires 16.4 or newer.

On other devices, use the browser's install/Add to Home Screen option when
available, or keep using a tab. HTTPS is needed for service workers and push.

## Link a device and manage sessions

An installed iOS app and a browser window can have separate authentication
storage. Device linking gives the destination its own session without relying
on the OAuth redirect returning to the installed app.

1. On a signed-in device or Safari window, open **Settings → Link a device**.
2. Copy the displayed code to the destination's sign-in screen.
3. Enter it and press **Use link code**. The destination becomes signed in as
   the same account.

The eight-character code is displayed in two groups. It works once within
five minutes. Generating another invalidates the previous code. Share it only
with the device you intend to sign in; anyone who redeems it gets your account
session. If it expires or was already used, generate another.

Settings lists signed-in devices with their browser labels and last-seen
times. Sign out a lost device, or choose **Sign out other devices** to keep
only this session. **Sign out** ends the current session and attempts to
remove this device's push subscription before clearing the local account view.
Signing out another session revokes API access; it does not itself perform
push unsubscription on that remote device.

## Conversations and the message box

**Conversations** combines instruction threads with live sessions. A thread
contains your queued note, follow-ups, delivery state, and replies. Live
sessions show the primary firstmate and its workers/scouts. Open an entry to
read it; the message box stays at the bottom of the conversation pane.

Use **+ New conversation** to write a fresh instruction. Type or dictate,
review the text, and press **Send to firstmate**. The send queues a note into
firstmate's existing intake. The receipt confirms queueing, not completion of
the requested work.

Sending in an existing thread creates a follow-up in that thread. Sending
while viewing a live session sends a note to firstmate about that session; it
does not type into the worker's terminal. That note appears as its own thread
marked as about the live session. Firstmate decides how to act on it.

A failed send keeps the text and request id. Retry with the same text in the
same conversation to avoid queueing a duplicate. Editing the text or changing
the conversation creates a new request id. Draft text is held in the page;
it is not a durable offline outbox. Copy an unsent draft before manually
reloading or closing the app.

Queued notes show how long they have waited and the current firstmate activity.
For example, a queued note while firstmate is working can mean it is finishing
work; a note queued while firstmate is not running cannot be picked up yet.
If the note has not been announced, the app says firstmate has not been woken.
Use the Status firstmate card to distinguish receiving readiness, queue age,
and activity rather than treating all delays as a failed send.

Live sessions read user/assistant text from OpenCode's session database. Use
**Load older messages** to page backwards. Tool calls and reasoning are not
shown, and very large messages are bounded. If history or the session mapping
is unavailable, the view falls back to the terminal's visible output; that
fallback is only a viewport, not full scrollback. Failure to list live sessions
does not prevent instruction threads from working.

Conversation badges come from firstmate's fleet state. **Needs you** means a
fleet decision or gate requires attention, **working** means work is in
flight, and **idle** means no such work is recorded. The firstmate activity
card uses a separate live primary signal; a blocked primary pane and a fleet
decision badge need not mean the same thing.

## Voice input

Hold **Hold to talk** while speaking, then release. On desktop, focus the
button and hold Space or Enter. Recognition appends text to the message box;
pauses restart recognition while you keep holding. Releasing preserves the
visible text, including interim words. Review and edit it before sending.
Pressing Send while dictating also stops capture.

The browser's Web Speech API supplies recognition. walkie-talkie has no
audio upload endpoint or separate transcription service; the browser's
recognition service may require network access. Availability depends on the
browser and permissions. If there is no supported API, the button is hidden.
If microphone permission is denied, allow it in browser settings or type.
The OS keyboard's dictation button is another way to fill the same field.

## Status and refresh

**Status** opens with a firstmate card above fleet work. It reports activity
(working, idle, blocked, not running, or unknown), whether notes can be
received, and the queue count and oldest queued time. Unknown means the
service could not establish that signal; it is not evidence that firstmate
stopped.

Status refreshes every 10 seconds while visible. Conversations refreshes its
lists every 5 seconds and open output every 3 seconds. Both stop polling in
the background and read fresh state when you return. **Refresh** requests a
read immediately. These are polling views, so changes are not instantaneous.

The service worker fetches the shell from the network first and uses cached
assets when the network fails. It does not cache API or sign-in responses.
Foreground return checks for an updated worker. A newer worker taking over a
previously controlled page reloads it when there is no typed draft, active
dictation, or send in progress. If a draft prevented the reload, save/copy
the draft and manually reload when ready. See
[stale-shell troubleshooting](operations.md#browser-and-ios-troubleshooting).

## Set up a managed firstmate

Setup appears only for signed-in users without a configured static tenant,
when the gateway has a catalog. Static-tenant owners have their model and
credentials managed by the operator and do not see this tab.

1. Choose a **Provider** from the offered catalog.
2. Paste your API key and choose **Check and save key**. A successful check
   stores it encrypted. It will not be shown again; keep your own copy in
   your secret manager.
3. Choose the **Main model**, optionally a cheaper model for routine work
   from the same provider, and press **Save choice**. A provider key must be
   saved first. Where the provider reports models available to that key,
   unavailable choices are refused.
4. Optionally save a GitHub personal access token when the catalog offers
   that field. This gives the runtime the supplied token for GitHub work.
   A successful profile check verifies the token works for `/user`; it does
   not prove it has permissions for every repository or operation you need.
5. When provisioning is enabled and setup is ready, press **Start my firstmate**
   in **Your firstmate**. On atus provisioning is currently off, so this
   card is hidden even after keys and choices are saved.

| State | Meaning |
| --- | --- |
| `none` | Never started |
| `provisioning` | Desired running; cluster state has not yet been observed |
| `starting` | Waiting for a Ready pod |
| `running` | The pod was observed Ready |
| `crashloop` | A container failed to start, including image or configuration errors |
| `stopping` | Stop/suspension is requested but pods remain |
| `stopped` | Scaled down; home and setup retained |

Setup re-reads provisioning, starting, and stopping every five seconds for a
bounded period. Reopen Setup to request fresh state if it remains unsettled.
Runtime `running` is a pod readiness signal; the Status card reports whether
the primary firstmate is currently receiving/working.

**Stop my firstmate** scales the workload down and retains its home and setup.
Start it again to reuse them. Replacing the chosen provider key, replacing or
removing the delivered GitHub token, or changing the model of a running
firstmate rolls its pod; work in flight is interrupted. Saving an unused
provider's key does not roll the running firstmate. Removing the chosen
provider key stops it, and the app requires a second tap. Save a replacement
key before starting again. Suspension by an admin also stops it and revokes
sessions; resume requires another sign-in and restores its prior desired state.

Common setup errors: `key_rejected` means the provider refused the key;
`provider_unreachable` means verification failed without storing a replacement;
`model_unavailable` means the key's recorded model list excludes that choice;
`key_required` means save the provider key first; `capacity_reached` means ask
the admin about available slots. Verification is limited to 10 checks per
minute per user and 60 overall; wait before retrying `busy`.

## Push notifications

In Settings choose **Enable on this device**, accept the browser permission
prompt, then **Send test**. The test goes to all subscribed devices of your
own firstmate. Disable removes this device's subscription. Permission denied
in browser/OS settings must be changed there before subscribing again.

Fleet events include a ready PR, a waiting decision, and a blocked worker.
Notifications deep-link back into the app; they do not approve, merge, or
resolve the event. Each firstmate owns its VAPID keys and subscriptions.
The app checks a signed-in device's subscription against its current
firstmate and replaces it when it was made with another firstmate's key.
Admin access-request notices need a running admin firstmate and a sidecar
that supports the notice route; see the [admin guide](admin-guide.md).
Push also requires a writable server-side store. If the app reports push is
not configured, ask the operator to check the
[static push-store setting](operations.md#persistence-backups-and-rollback).

## Standalone and older devices

For a standalone deployment, enter the operator-provided bearer in Settings.
It is saved in this browser's localStorage as you type and on blur. **Save
token** verifies it against the status API. A rejected current token clears
and opens Settings; **Forget token** clears it locally. There is no GitHub
account or device-linking interface in standalone mode.

On a gateway during migration, a previously saved shared bearer may continue
to reach the configured admin's firstmate. Sign in with GitHub on each device
to replace it with an individual session. The shared bearer does not grant
Setup, Admin, or session/device controls. After the operator disables the
bridge, sign-in is required. If the operator rolls back to standalone, enter
the upstream bearer again; successful GitHub sign-in removed your old copy.
