// Which scraped listings are not pet businesses.
//
// The directory was scraped by category keyword, so human healthcare, pest
// control and cab firms landed under pet categories ("Vaccination Centers" is
// mostly CVS MinuteClinics; an Ayurvedic doctor sat under Veterinary Clinics).
// Such a listing is treated as hidden on every public surface (see
// listings/index.ts) and skipped by the static export
// (scripts/export-listings-static.mjs keeps an identical copy of these lists —
// keep the two in step). A name with any pet word is always kept.

export const PET_WORDS =
  /(pets?\b|vet(?!eran)|veterinar|animal|dogs?\b|doggie|doggy|cats?\b|kitty|kitten|canine|k-?9|feline|paws?|pup|bark|woof|wag|mutt|hound|kennel|groom|fetch|furr?y?\b|fur\b|whisker|purr|meow|tail|birds?\b|avian|parrot|aquari|fish|reptile|exotic|zoo|livestock|cattle|poultry|equine|horse|rescue|sanctuary|shelter|spca|humane|dvm|petco|petsmart|critter|bunny|rabbit)/i;

export const NOT_PET_BUSINESS =
  /\b(patholog\w*|sonograph\w*|maternity|gyna?ec\w*|obstetric\w*|ivf|infertility|nursing home|diabet\w*|health cent(?:re|er)|multi-?speciality|paediatric\w*|pediatric\w*|physician|urolog\w*|cardiolog\w*|orthopa?edic\w*|pregnancy|uphc|primary health|endocrinolog\w*|laparoscop\w*|dermatolog\w*|neurolog\w*|oncolog\w*|polyclinic|poly clinic|urgent care|minuteclinic|physiotherap\w*|physical therap\w*|chiropract\w*|labcorp|quest diagnostics|dentist\w*|dental clinic|orthodont\w*|cryo\w*|counsel\w*|psychiatr\w*|psycholog\w*|lpc|lcsw|ayurved\w*|sexolog\w*|migraine|depression|panchakarma|homeopath\w*|homoeopath\w*|colon|weight ?loss|slimming|swasthya|b\.?\s?a\.?\s?m\.?\s?s|m\.?b\.?b\.?s|piles|fistula|lasik|eye ?care|eye clinic|skin clinic|hair clinic|cosmetic|invisible grill|net dealer|pest control|termite|mosquito)\b/i;

const CAB_FIRM = /\b(taxi|cabs?|car rentals?|limo\w*|black car|chauffeur\w*|trucker|airport)\b/i;

/** Plain letters for "𝐃𝐫. 𝐘𝐨𝐠𝐞𝐬𝐡"-style styled Unicode, which many phones render as boxes. */
export function plainText(s: string): string {
  return String(s || '').normalize('NFKC');
}

export function isNotPetBusiness(name: string, categorySlug: string): boolean {
  const n = plainText(name);
  if (PET_WORDS.test(n)) return false;
  const cat = String(categorySlug || '').toLowerCase();
  if (cat === 'vaccination-centers') return true;
  if (cat === 'pet-taxi-transport' && CAB_FIRM.test(n)) return true;
  return NOT_PET_BUSINESS.test(n);
}
