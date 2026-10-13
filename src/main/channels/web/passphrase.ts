/**
 * The master password Wolffish generates for itself.
 *
 * The Web UI is on from the first launch, so there has to be a password
 * before anyone has typed one — and because the browser keeps it forever and
 * the door can face the internet, it is a passphrase rather than a string
 * of symbols: twelve words from the list below, drawn with the system CSPRNG.
 * At 1,700-odd words that is about 129 bits, the same as a 12-word wallet
 * phrase, and it is far easier to read off a terminal and type on a phone
 * than 20 random characters.
 *
 * The generated phrase is stored in clear in config.json next to the hash,
 * so the desktop panel and `wolffish web password` can show it on a box with
 * no screen. That is the same posture config.json already takes for API
 * keys: whoever can read the workspace already owns the agent. A password
 * the user picks instead is stored hashed only — it may be reused elsewhere,
 * so it is never written down.
 */
import { randomInt } from 'node:crypto'
import { hashPassword } from '@main/channels/web/auth'
import { getWebUiConfig, setWebUiConfig } from '@main/workspace/workspace'

export const PASSPHRASE_WORD_COUNT = 12

const WORDLIST = `
  able acorn act active actor add admire adopt advise agent agile agree
  aim air album alert alley allow almond amber ample anchor ancient angel
  angry ankle answer ant anvil ape apple apricot apron arena argue arrive
  arrow artist ash ask atlas atom attach attend attic author autumn avenue
  await awake aware axe azure baby bacon badge badger bag bagel bake
  baker ball ballet bamboo banana banjo banner barber barley barn barrel basic
  basil basin basket bat bathe bay beach beacon beaker bean bear beard
  beat beaver bee beef beg beige bell belong belt bench bend berry
  bind bingo birch bird biscuit bishop bison bite bitter black blade blank
  blanket bleak blend blink bloom blue blues blunt boar boat bobbin body
  boil bold bolt bonus book boot borrow bottle bottom bounce bounty bow
  bowl box brain branch brand brass brave bread breath breathe breeze brick
  bride bridge brief bright bring brisk broad broil bronze brook broom broth
  brown brownie browse brush bucket buckle bud buddy budget buffet bugle build
  bull bump bumpy burger burn bush busy butler butter button buy cabin
  cable cactus cadet cake calf call calm camel camera camp canal cancel
  candid candle candy cannon canoe canvas canyon cap capital captain card career
  cargo carol carpet carrot carry cart carve cashew castle cat catch cave
  cedar celery cellar census chain chair chalk chapel chase cheap cheek cheer
  cheese chef cherry chess chest chew chief child chili chilly chin chisel
  chive choir choose chop chorus chrome cider cinema circle circus citrus city
  civil claim clam clap clay clean clear clerk clever client cliff climb
  clinic clock close cloth cloud clover club coach coast coat cobalt cobbler
  cobra cocoa coconut code coffee coin cold collect colt comb come comet
  comic compare compass cook cookie cool copper copy coral cork corn corner
  cosmos cottage cotton couch count county court cousin cover cow cowboy cozy
  crab cracker cradle craft crane crate crawl crayon cream create creek crew
  crimson crisp cross crow crown cruise crust cub cup curly curry curtain
  custard cut cute cycle dagger daily daisy damp dance dancer dare dark
  date dawn deal dear debut decade decide deep deer define degree deliver
  delta demo denim dense dentist depend depot desert design desk detect dew
  dial diary dice diet dig dill dingo dinner dish dive divide dizzy
  doctor dog dollar dome donate donkey donut door double doubt dove dragon
  drama draw drawer dream drill drink drive driver drop drum dry duck
  dull dune dusk dwarf eager eagle early earn earth easel easy eat
  ebony echo edge edit eel egg elbow elder elf elk elm empire
  employ empty emu energy engine enjoy enter equal era error escape essay
  even event exact exam exit expand expect explore extra fable fabric fact
  fade faint fair fairy falcon family famous fan fancy farm farmer fast
  fasten fatal fate faucet fawn feast feed fellow fence fennel fern ferret
  fetch fever fiber fiddle field fierce fig fight figure fill film finch
  find fine finger finish fire firm fish fit fix fjord flag flame
  flash flask flat flavor flax flea flee flight flip float flood flour
  flower fluffy fly focus fog fold folk follow fond forest forget forgive
  fork formal forum fossil fox frame frank free freeze fresh friend fringe
  frog frost fruit full funnel funny fuzzy gain galaxy gallon game garage
  garden garlic gate gather gavel gaze gazelle gear gecko genius genre gentle
  geyser ghost giant gift giggle ginger give glacier glad glance glass glide
  glory glove glow goal goat goblet gold golden good goose gopher gospel
  grab grace grade grain grand grant grape grass gravy gray great green
  greet grin grind groan grove grow grumpy guard guava guess guest guide
  guitar gulf gull habit hail hall ham hammer hamster handle handy hang
  happen happy harbor hardy hare harp harvest hasty hat hatch haven hawk
  hazard hazel heal hear heart heavy helmet help hen herb hero heron
  hidden hide high hike hill hinge hobby hold hollow holly home honest
  honey honor hook hop horn horse hotel hound hour house hover hug
  huge hum humble humor hungry hunt hyena ibis ice icy idea ideal
  idle idol ignore image imagine import index indigo infant inn inner insect
  invent invite iris iron island ivory ivy jacket jade jaguar jam jar
  jasmine javelin jeans jelly jester jewel jog join joke jolly judge juggle
  juice juicy jump jungle jury kayak keen keep kernel kettle key khaki
  kick kind kindle king kite kitten kiwi kneel knife knight knit knob
  knock koala lab label ladder lady lagoon lake lamb lamp lane lantern
  large lark laser lasso latch late laugh launch laurel lava lawn lawyer
  lazy lead leaf lean leap learn leave legend lemon lemur lend lens
  lentil leopard lesson letter lettuce level lever lichen lid lift light lilac
  lily lime limit linen linger lion listen little live lively lizard llama
  lobby lobster locate lock logic lonely long look loose lord lotus loud
  lounge loyal lucky lumpy lunch lynx lyric mad magic magnet magpie mail
  main major make mallet manage mango manor mantis mantle map maple marble
  march mark market marlin maroon marvel mask mason mat mauve mayor meadow
  measure medal media medic meerkat meet mellow melody melon melt memo mend
  mentor menu merit merry metal meter method metro mighty mild milk miner
  mingle minor mint minute mirror mist misty mix model modern modest moist
  mole moment money monkey month moon moose mop mortar moss moth motor
  motto mouse move movie mud muddy muffin muffler mug mule mumble murmur
  museum music mutual myth nail name nap narrow nation native nature navy
  neat needle nephew nerve nervous net nettle new news newt nice nickel
  niece night nimble ninja noble nod noisy noodle noon normal north notice
  novel nozzle number nurse nut nutmeg oak oar oasis oat oath object
  obtain ocean odd offer office old olive onion open opera orange orbit
  orchid order organ origin otter outfit oval oven owl oyster pack pact
  paddle page pail paint palace pale pallet palm pan panda panel pansy
  panther papaya paper parade parcel pardon parent park parrot parsley party pasta
  pastor pastry patent path patrol pause pea peach peak peanut pear pearl
  pebble pecan pedal peel pelican pen pencil penguin penny peony people pepper
  perch period permit person pestle petal phone photo phrase piano pick pickle
  picnic pie pig pigeon piglet pillow pilot pin pine pink pipe pirate
  pitcher pixel pizza place plain planet plank plant plate play plaza plead
  pledge pliers plot plow plug plum plump plunge pocket poem poet point
  police polish polite pond ponder pony poor poppy poster pot potato pouch
  pour prairie praise pray prefer prepare press pretty pretzel prime prince prison
  prize profit proof proper proud prove pull pulley puma pump pumpkin punch
  pupil puppy pure purple purse pursue push puzzle python quail quartz queen
  quest quick quiet quilt quince quiz quote rabbit race radar radio radish
  rain raise raisin rake rally ranch ranger rapid rare raven raw razor
  reach read ready real reason rebel recall recipe record red reduce reed
  reef refuse region relax relic remain remind remove repair repeat reply report
  rescue rest return reveal review revive reward rhino rhythm ribbon rice rich
  riddle ride ridge ring ripe ripen rise rival river road roam roar
  robe robin robot robust rock rocket rodeo roll roof rookie rooster root
  rope rose rotate rough round route row royal rubber ruby rudder rude
  rug ruler rumor run rush rust rusty rye sad saddle safe saffron
  saga sage sail sailor salad salmon salon salt salty sample sand sandy
  sardine satin sauce save saw say scale scallop scarce scarf scarlet scatter
  scene scheme school scold scoop score scout scrape screw script scrub sea
  seagull seal search season secret sector see seed select sell senate send
  sensor series sermon serve sesame settle sew shade shadow shake share shark
  sharp sheep shelf shield shine shiny ship shiver shoe shore short shout
  shovel show shrimp shrine shrug shy sickle sieve sign signal silent silk
  silly silver simmer simple sing sink sip siphon siren sister sit skate
  sketch skill skillet skip skunk sky sled sleek sleep slice slide slim
  slogan slope sloth slow small smart smile smoke smooth snail snake snatch
  sneak sneeze sniff snow snug soar soccer sock sofa soft soil soldier
  solid sonnet soothe sorbet sort soup sour spade spare sparkle sparrow spatula
  speak speech speedy spice spicy spider spin spinach spirit splash sponge spool
  spoon sport spread spring sprint squad square squash squeeze squid stable stack
  stadium stage stamp stand stapler star stare statue status steady steak steam
  steel steep steer stem stern sticky stiff still stir stirrup stomp stone
  stool stop stork storm story stout stove strap stream stretch strike string
  stroll strong studio study sturdy style submit subtle suburb sugar summer summit
  sun sunny super supply survey swallow swamp swan sway sweep sweet swift
  swim swing sword symbol syrup system table tackle taco tailor take talent
  talk tall tame tan tangle tank tap tape target tassel taste tavern
  taxi tea teach teal teapot tease tell temple tempt tender tennis tense
  tent termite thank theory thesis thick thimble thin think thorn thread throne
  throw thunder thyme ticket tickle tide tidy tie tiger tight tile timber
  tin tiny tire tired title toad toast tofu token tomato toolbox topic
  topple torch toss toucan touch tough tourist towel tower toy trace trade
  trail train travel tray treaty tree tremble tribe trim tripod triumph trophy
  trot trout trowel truck true truffle trumpet trunk trust tube tug tulip
  tumble tuna tunnel turkey turn turnip turtle tutor tweezer twist type uncle
  unfold union unit unite unlock update uphold upper urban useful vague valid
  valley value valve vanilla vanish vase vast velvet vendor verify verse vessel
  vest video villa vine violet violin viper vision visit visor vivid voice
  volume voyage wade waffle wager wagon wait wake walk wallet walnut walrus
  wand wander warden warm warn wary wash wasp waste watch wave weak
  wear weary weasel weave wedding wedge week welcome wet whale wharf wheat
  wheel whip whisk whisper whistle white whole wick wide widen wiggle wild
  willow win wind window wink winner winter wire wise wish witty wizard
  wolf wombat wonder wood wool work world worm worthy wrap wrench write
  writer yacht yak yam yarn yawn year yell yellow yield yogurt young
  youth zany zebra zest zesty zinc zipper zone zoo zoom
`

/** Common, short, unambiguous English words — 3 to 7 letters, no repeats. */
export const PASSPHRASE_WORDS: readonly string[] = Object.freeze(WORDLIST.trim().split(/\s+/))

export function generatePassphrase(words = PASSPHRASE_WORD_COUNT): string {
  const picked: string[] = []
  for (let i = 0; i < words; i++) picked.push(PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)])
  return picked.join(' ')
}

/** Replace the master password with a fresh generated passphrase and return it. */
export async function regenerateWebUiPassword(): Promise<string> {
  const password = generatePassphrase()
  await setWebUiConfig({ password, passwordHash: await hashPassword(password) })
  return password
}

/**
 * Make sure a master password exists. Runs on every launch and acts only
 * when there is none — a fresh install, or a workspace from before the Web
 * UI was on by default — so a password the user set is never touched.
 */
export async function ensureWebUiPassword(): Promise<{ generated: boolean }> {
  const config = await getWebUiConfig()
  if (typeof config.passwordHash === 'string' && config.passwordHash.length > 0) {
    return { generated: false }
  }
  await regenerateWebUiPassword()
  return { generated: true }
}
