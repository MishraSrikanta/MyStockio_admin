/**
 * Which product a customer is on.
 *
 * Three things here would be silently wrong rather than loudly broken:
 *
 *   · **An account with no `softwareType` is on MyStockio.** Every account older than the field is,
 *     because Mini came later. Read as "unknown" instead, it would put a question mark against the
 *     entire existing customer base — and read as Mini, it would tell support the wrong thing about
 *     every one of them.
 *   · **Mandatory on the form, defaulted on read.** Those are not in conflict: refusing to guess for
 *     a *new* customer is the point, and reading history as history is a separate question.
 *   · **Staff have no edition of their own.** A cashier uses whatever the shop uses, so the value
 *     belongs to the owner and is resolved live — an upgrade must move the counter with it.
 */

import {
  asSoftwareType,
  checkSoftwareChoice,
  SOFTWARE_LABEL,
  SOFTWARE_NOTE,
  SOFTWARE_TYPES,
  SoftwareType,
  softwareLabelOf,
  softwareOf,
} from '../../src/lib/software'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/* ═══════════════════════════════════════════════ the two editions ══ */

console.log('the two editions')

check('the enum carries the wire values', SoftwareType.Full === ('mystockio' as SoftwareType) && SoftwareType.Mini === ('mystockio_mini' as SoftwareType))
check('both are listed', SOFTWARE_TYPES.length === 2, SOFTWARE_TYPES.join(','))
check('the full product comes first', SOFTWARE_TYPES[0] === SoftwareType.Full)
check('each has a label', SOFTWARE_TYPES.every((type) => (SOFTWARE_LABEL[type] ?? '').length > 0))
check('...spelled as the product is', SOFTWARE_LABEL[SoftwareType.Full] === 'MyStockio' && SOFTWARE_LABEL[SoftwareType.Mini] === 'MyStockio Mini')
check('each has a note', SOFTWARE_TYPES.every((type) => (SOFTWARE_NOTE[type] ?? '').length > 0))

check('a known edition is recognised', asSoftwareType('mystockio_mini') === SoftwareType.Mini)
check('an unknown one is not', asSoftwareType('mystockio_micro') === null)
/* A near-miss is the case that matters: accepted silently, it puts a shop on the wrong product. */
check('a near-miss is refused, not corrected', asSoftwareType('mystockio_minii') === null)
check('a non-string is not', asSoftwareType(1) === null && asSoftwareType(undefined) === null && asSoftwareType(null) === null)

/* ══════════════════════════════════ reading what an account is on ══ */

console.log('\nreading an account')

check('an explicit edition is read', softwareOf({ softwareType: 'mystockio_mini' }) === SoftwareType.Mini)

/*
 * The default that protects every existing customer. An account created before this field existed
 * has no value, and it is on the full product — Mini came later.
 */
check('no value reads as MyStockio', softwareOf({}) === SoftwareType.Full)
check('...and so does null', softwareOf({ softwareType: null }) === SoftwareType.Full)
check('...and an empty string', softwareOf({ softwareType: '' }) === SoftwareType.Full)
check('rubbish reads as MyStockio rather than as Mini', softwareOf({ softwareType: 'nonsense' }) === SoftwareType.Full)

check('a label comes back for the screen', softwareLabelOf({ softwareType: 'mystockio_mini' }) === 'MyStockio Mini')
check('...and for an account with no value', softwareLabelOf({}) === 'MyStockio')

/* ═════════════════════════════════════ the form refuses to guess ══ */

console.log('\nchoosing on the form')

/*
 * Mandatory means an explicit choice. Nothing is pre-selected, so "" is the state the form starts in
 * and it must not be submittable — pre-picking an edition answers a commercial question on the
 * operator's behalf, and the wrong answer surfaces months later as a support call.
 */
const missing = checkSoftwareChoice('')
check('an unchosen edition is refused', missing !== null, missing ?? '')
check('...saying what to do', (missing ?? '').includes('Choose'), missing ?? '')

check('either edition is accepted', checkSoftwareChoice('mystockio') === null && checkSoftwareChoice('mystockio_mini') === null)

const wrong = checkSoftwareChoice('mystockio_pro')
check('an edition that does not exist is refused', wrong !== null, wrong ?? '')
check('...with a different message from the missing one', wrong !== missing)

console.log()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
