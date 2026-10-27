// Word lists used by the in-browser detector. Everything is lower-case for matching.

const words = (s: string) => new Set(s.trim().split(/\s+/).map((w) => w.toLowerCase()));

/** Common given names. */
export const FIRST_NAMES = words(`
  aaron abby abdul abigail adam adrian ahmed aidan aisha alan albert alex alexa alexander alexandra alfred ali alice
  alicia alison allan allison alyssa amanda amber amelia amir amy ana andre andrea andrew andy angela angelina anita
  ann anna anne annie anthony antonio april archie arjun arnold arthur ashley audrey austin ava barbara barry beatrice
  becky ben benjamin bernard beth betty beverly bill billy blake bob bobby bonnie brad bradley brandon brenda brendan
  brian bridget brittany brooke bruce bryan caitlin caleb calvin cameron camila carl carla carlos carmen carol caroline
  carolyn carter casey catherine charles charlie charlotte chelsea cheryl chloe chris christian christina christine
  christopher cindy claire clara claudia clifford colin connor craig cynthia daisy dale dan dana daniel danielle
  danny darren dave david dean debbie deborah denise dennis derek diana diane diego dominic donald donna doris dorothy
  douglas dylan eddie edgar edith edward elaine eleanor elena eli elijah elizabeth ella ellen ellie emily emma emmanuel
  eric erica erik erin ernest esther ethan eugene eva evan evelyn faith fatima felix fernando fiona florence frances
  francesca francis frank fred freddie frederick gabriel gabriella gail gary gavin gemma george georgia gerald gina
  gloria gordon grace graham grant greg gregory hailey hannah harold harper harriet harrison harry harvey hassan hayley
  heather hector helen henry holly howard hugh hugo ian ibrahim irene isaac isabel isabella isabelle isla ivan jack
  jackie jackson jacob jacqueline jade jake james jamie jan jane janet janice jared jasmine jason javier jay jean jeff
  jeffrey jenna jennifer jenny jeremy jerry jesse jessica jill jim jimmy joan joanna joanne joe joel john johnny jon
  jonathan jordan jorge jose joseph josh joshua joy joyce juan judith judy julia julian julie justin karen kate katherine
  kathleen kathryn kathy katie kayla keith kelly ken kenneth kevin khalid kim kimberly kirsty kyle laura lauren lawrence
  layla leah lee leo leon leonard lewis liam lily linda lindsay lisa logan lois lorraine louis louise lucas lucy luis
  luke lydia lynn madison maggie malcolm marcus margaret maria marie marilyn mario mark martha martin marvin mary mason
  matt matthew maureen max maya megan melanie melissa mia michael michelle miguel mike mila millie mohammed molly monica
  morgan muhammad nancy naomi natalie natasha nathan neil nicholas nick nicole nina noah nora norman oliver olivia omar
  oscar owen pamela patricia patrick paul paula pauline peter phil philip phillip phoebe priya rachel raj ralph ramon
  randy ray raymond rebecca reggie rhys ricardo richard rick ricky rita rob robert roberto robin roger ronald rosa rose
  ross roy ruby russell ruth ryan sally sam samantha samuel sandra sara sarah scarlett scott sean sebastian seth shane
  sharon shawn sheila shirley simon sofia sophia sophie stacy stanley stella stephanie stephen steve steven stuart sue
  susan suzanne sylvia tanya tara ted teresa terry theo theresa thomas tiffany tim timothy tina toby todd tom tommy tony
  tracy travis trevor troy tyler valerie vanessa victor victoria vincent virginia walter wanda wayne wendy william
  willie xavier yasmin yusuf zach zachary zainab zara zoe
`);

/** First names that are also everyday words ("Bill to", "Mark the date"). Alone, they need a cue such as "Hi". */
export const AMBIGUOUS_NAMES = words(`
  bill mark will grace may rose faith joy hope june april august art frank chase dean ray rich robin sandy summer
  amber dawn eve iris ivy max miles penny rob sky victor holly heather jack page lee jean carter mason hunter grant
  ruby crystal august stella hugh drew wade
`);

/** Words that look like names when capitalised but almost never are. */
export const NOT_NAMES = words(`
  a an and the this that these those our your my their his her its we you they i it he she
  send please dear hi hello hey call email pay ask tell meet remind forward message ping invite notify cc bcc also invoice from to for with by on in at of as or but if
  thanks thank regards best kind sincerely cheers note notes reminder urgent update agenda summary total amount balance
  due phone mobile contact client brief budget approved draft meeting subject re fwd attachment kick-off kickoff
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august
  september october november december today tomorrow yesterday morning afternoon evening
  mr mrs ms miss dr prof sir madam
  bank ltd limited plc inc llc company group university college school ministry agency federal state government
  street road avenue close crescent way lane estate house office hospital church mosque market
  support team service services customer customers department manager director officer staff sales marketing
  account accounts billing finance legal operations admin help desk centre center terms conditions
  privara agent agents policy policies privacy action actions lab tool tools file files sandbox outbox protected
  api mcp rest json http https ai openai claude gpt model models
`);

/** Countries and major cities. Multi-word entries are matched as phrases. */
export const LOCATIONS: string[] = `
  Ghana|Kenya|South Africa|Egypt|Morocco|Senegal|Cameroon|Ethiopia|Rwanda|Uganda|Tanzania|
  United Kingdom|United States|USA|UK|Canada|Germany|France|Italy|Spain|Netherlands|Ireland|Portugal|Belgium|Switzerland|
  Sweden|Norway|Denmark|Poland|India|China|Japan|Singapore|Brazil|Mexico|Australia|United Arab Emirates|UAE|Saudi Arabia|Qatar|Turkey|
  Accra|Kumasi|Nairobi|Mombasa|Johannesburg|Cape Town|Durban|Cairo|Casablanca|Dakar|Addis Ababa|Kigali|Kampala|Dar es Salaam|
  London|Manchester|Birmingham|Edinburgh|Dublin|Paris|Berlin|Munich|Madrid|Barcelona|Rome|Milan|Amsterdam|Brussels|Zurich|
  Geneva|Stockholm|Oslo|Copenhagen|Warsaw|Lisbon|New York|Los Angeles|San Francisco|Chicago|Houston|Boston|Seattle|
  Washington|Atlanta|Miami|Toronto|Vancouver|Montreal|Dubai|Abu Dhabi|Riyadh|Doha|Istanbul|Mumbai|Delhi|Bangalore|
  Beijing|Shanghai|Hong Kong|Tokyo|Singapore|Sydney|Melbourne|Sao Paulo|Mexico City
`
  .split("|")
  .map((s) => s.trim())
  .filter(Boolean);
