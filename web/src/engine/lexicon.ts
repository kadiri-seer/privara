// Word lists used by the in-browser detector. Everything is lower-case for matching.

const words = (s: string) => new Set(s.trim().split(/\s+/).map((w) => w.toLowerCase()));

/** Common given names (Nigerian — Yoruba, Igbo, Hausa, Edo, Efik — and widely used international names). */
export const FIRST_NAMES = words(`
  abdul abdullahi abdulrahman abu abubakar adaeze adamu ade adebayo adebola adedayo adekunle ademola adeola adeyemi
  adewale adunni afolabi aisha ama amaka amina aminu amara aminat ayo ayobami ayodele ayomide babajide babatunde
  bashir bisi bola bolanle bukola chiamaka chibuike chidi chidinma chidera chiemeka chika chike chinedu chinonso
  chinwe chioma chisom chukwuemeka chukwuma damilare dayo ebuka efe ekene emeka emmanuel eniola esther ezinne fatima
  fatimah femi folake folasade funke funmilayo gbenga habiba hadiza hafsat halima hassan ibrahim idris ifeanyi ifeoma
  ijeoma ikenna ini iyabo jide jumoke kabiru kadiri kayode kehinde kemi kunle ladi lanre maryam musa mustapha nafisa
  nkechi nkem nneka nnamdi nonso obinna obi ogechi olamide olawale olu oluchi olufemi olumide oluwaseun oluwatobi
  omolara onyeka onyinye opeyemi osaze osagie osas osaro osemudiamen sade sadiq salisu samuel segun seun shehu sola
  somto tade taiwo temi temitope titi tobi tola tolu tunde uche uchenna ugochi umar usman uzoma yakubu yemi yetunde
  yinka yusuf zainab zara
  aaron adam adrian aisha alex alexander alice amanda amy andrew angela anna anne anthony arthur ben benjamin brian
  carlos caroline catherine charles charlotte chris christopher claire daniel david deborah diana elizabeth emily emma
  eric ethan grace hannah harry helen henry isaac isabella jack jacob james jane jason jennifer jessica john joseph
  joshua julia karen kate kevin laura linda lucy luke maria mark martin mary matthew michael michelle mohammed
  muhammad nancy natalie nicholas noah oliver olivia paul peter rachel rebecca richard robert ruth ryan sarah sophia
  stephen steven susan thomas victoria william
`);

/** Words that look like names when capitalised but almost never are. */
export const NOT_NAMES = words(`
  a an and the this that these those our your my their his her its we you they i it he she
  send please dear hi hello hey call email pay ask tell meet invoice from to for with by on in at of as or but if
  thanks thank regards best kind sincerely cheers note notes reminder urgent update agenda summary total amount balance
  due phone mobile contact client brief budget approved draft meeting subject re fwd attachment kick-off kickoff
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august
  september october november december today tomorrow yesterday morning afternoon evening
  mr mrs ms miss dr prof sir madam chief alhaji alhaja engr barr
  bank ltd limited plc inc llc company group university college school ministry agency federal state government
  street road avenue close crescent way lane estate house office hospital church mosque market
  privara agent agents policy policies privacy action actions lab tool tools file files sandbox outbox protected
  api mcp rest json http https ai openai claude gpt model models
`);

/** Countries, Nigerian states and major cities. Multi-word entries are matched as phrases. */
export const LOCATIONS: string[] = `
  Nigeria|Ghana|Kenya|South Africa|Egypt|Morocco|Senegal|Cameroon|Benin|Togo|Niger|Chad|Ethiopia|Rwanda|Uganda|Tanzania|
  United Kingdom|United States|USA|UK|Canada|Germany|France|Italy|Spain|Netherlands|Ireland|Portugal|Belgium|Switzerland|
  Sweden|Norway|Denmark|Poland|India|China|Japan|Singapore|Brazil|Mexico|Australia|United Arab Emirates|UAE|Saudi Arabia|Qatar|Turkey|
  Abia|Adamawa|Akwa Ibom|Anambra|Bauchi|Bayelsa|Benue|Borno|Cross River|Delta|Ebonyi|Edo|Ekiti|Enugu|Gombe|Imo|Jigawa|
  Kaduna|Kano|Katsina|Kebbi|Kogi|Kwara|Lagos|Nasarawa|Ogun|Ondo|Osun|Oyo|Plateau|Rivers|Sokoto|Taraba|Yobe|Zamfara|FCT|
  Abuja|Ikeja|Lekki|Victoria Island|Ikoyi|Yaba|Surulere|Ibadan|Port Harcourt|Benin City|Onitsha|Aba|Owerri|Calabar|Uyo|
  Jos|Ilorin|Abeokuta|Akure|Osogbo|Ado Ekiti|Asaba|Warri|Maiduguri|Zaria|Yola|Makurdi|Lokoja|Minna|Garki|Wuse|Maitama|Gwarinpa|
  Accra|Kumasi|Nairobi|Mombasa|Johannesburg|Cape Town|Durban|Cairo|Casablanca|Dakar|Addis Ababa|Kigali|Kampala|Dar es Salaam|
  London|Manchester|Birmingham|Edinburgh|Dublin|Paris|Berlin|Munich|Madrid|Barcelona|Rome|Milan|Amsterdam|Brussels|Zurich|
  Geneva|Stockholm|Oslo|Copenhagen|Warsaw|Lisbon|New York|Los Angeles|San Francisco|Chicago|Houston|Boston|Seattle|
  Washington|Atlanta|Miami|Toronto|Vancouver|Montreal|Dubai|Abu Dhabi|Riyadh|Doha|Istanbul|Mumbai|Delhi|Bangalore|
  Beijing|Shanghai|Hong Kong|Tokyo|Singapore|Sydney|Melbourne|Sao Paulo|Mexico City
`
  .split("|")
  .map((s) => s.trim())
  .filter(Boolean);
