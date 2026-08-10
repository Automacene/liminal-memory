# Chat session

A worked example and the integration test, in the same code.

```bash
npm run example                  # watch it, one turn at a time
npm run example -- --fast        # no delay
npm run example -- --slow        # slower, for reading along
npm run example -- --delay=150   # whatever pace you like, in milliseconds
npm run test:examples            # the same claims as assertions
```

`npm test` runs the example's assertions too, since it discovers every `*.test.js` in the repo.
`test:examples` is just for running them on their own.

No network, no api key, no model. The library never talks to a model anyway, so the example
stops at the prompt it would have sent.

## What it shows

Every turn scrolls past as it happens, with counters showing the two pools. Turn 9 is flagged as
worth remembering. Around turn 69 you watch it drop out of the window. Thirty turns later
somebody asks about it, and you see both prompts: the one a plain sliding window would have
sent, which has nothing, and the one recall builds, which has the answer.

The summary at the end is measured during the run rather than written in advance, so every line
of it refers to something that went past on screen.

## Reading a turn

Every turn prints what went into its prompt:

```
turn 70/99
[pools]    active 60   recall 10   nudge 0   tools 4
> did the load test finish?
< yes, held up to about eight hundred concurrent.

[recalled]
  1.92  "morning, anything blocking?"
[tools]    None
[nudges]   None
[dropped]  "are we booked for anything friday?"
```

Every section under the exchange is a pool being searched, so each one shows its hits with
scores, or `None`. Tools are no different from memories: the model says what it wants, that
phrasing searches the tool pool, and whatever ranks highly comes back.

## About those recall scores

You will see turns recall something only loosely related, like the one above matching on
"finished" against "finish". That is real BM25 behavior on short conversational text, and it is
worth knowing that a score threshold does not fix it: measured on this transcript, the
incidental match scores 3.32 while the genuinely relevant cluster scores 2.04 to 2.13. A rare
word in a short turn outranks a common word in three longer ones.

So the score is printed rather than filtered on. Tuning this for real is a matter of better
tagging, longer content per node, or a cutoff fitted to your own corpus, and none of those
belong in a library that promises the same answer every time.

The final question is unaffected: it returns the three planted turns and nothing else.

## The four pools

| Pool | Holds | Why it is separate |
|---|---|---|
| `active` | the last 60 turns | Always sent in full, so never worth searching |
| `recall` | every turn that aged out | Searched. Disjoint from active, so it cannot return something already in the prompt |
| `nudge` | one instruction, at most | Rides along with the next prompt, then is evicted |
| `tools` | four tool definitions | Short text that would rank oddly if indexed alongside long turns |

A turn is not copied into `recall` when it is created. It is moved there when it slides out of
`active`, by the eviction hook. That is the whole of "long term memory" here: one hook, five
lines, and there is only ever one copy of each turn.

## What happens in a turn

The turn node is created first, because it is the node doing the asking. Recall is searched with
`from` set to that node, which leaves the turn out of its own results and links whatever comes
back to it. Those edges cross pools, since `active` and `recall` share one id space.

Tools are searched separately, and not with the user's words. The fake model reads the message
and emits its own phrasing of what it wants, and that phrasing is what searches the tool pool.
The example includes a case where this matters: a user asking "are we booked for anything
friday?" matches nothing in a tool described as "find scheduled meetings on the team calendar",
because the two share no words. The model's rephrasing bridges the gap. That is what function
calling actually does, and it is why the step exists.

## Two disclaimers

**The numbers are small on purpose.** 99 turns and a 60-turn window keep the output readable.
Real use is thousands of turns, and the interesting behavior does not change.

**The window is capped by turn count, not tokens.** The library does no token math at all, which
is deliberate: budgeting depends on your model, your tokenizer, and what else you are putting in
the prompt. `buildPrompt` in [session.js](session.js) is where you would do it, and the comment
there says so.

## Files

- [session.js](session.js) is the part worth copying. Everything else is scaffolding.
- [fixtures.js](fixtures.js) is the transcript and the tool definitions.
- [fake-llm.js](fake-llm.js) stands in for a model, doing two jobs: deciding what tool it wants,
  and writing a reply.
- [run.js](run.js) prints the walkthrough.
- [session.test.js](session.test.js) asserts everything the walkthrough claims.
