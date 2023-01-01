import json

def list_of_seq_unique_by_key(seq, key):
    seen = set()
    seen_add = seen.add
    return [x for x in seq if x[key] not in seen and not seen_add(x[key])]

frank_recommendation = {'5C': 9,
                        '4C': 9,
                        '3C': 10,
                        '2C': 12,
                        '5CC': 12,
                        '1C': 13,
                        '4CC': 13,
                        'C': 14,
                        '3CC': 15,
                        '4CCC': 16,
                        '2CC': 16,
                        '3CCC': 17,
                        '1CC': 18,
                        '2CCC': 19,
                        'CC': 21,
                        '1CCC': 21,
                        '1CCCC': 22,
                        'CCC': 23,
                        'CCCC': 24}

deck_min_requirements = {'W':0, 'U':0, 'B':0, 'R':0, 'G':0}

with open('/mnt/c/Users/dlshaffer/Downloads/standard_mtg_cards.json', 'r') as card_file:
    card_data = json.load(card_file)

cards_in_deck=[]
with open('/mnt/c/Users/dlshaffer/Downloads/example_deck.txt', 'r') as deck_file:
    for line in deck_file:
        cards_in_deck.append(' '.join(line.split()[1:-2]))

#remove empty items
cards_in_deck=[i for i in cards_in_deck if i]

all_card_data=list(filter(lambda card: card['name'] in cards_in_deck, card_data))
unique_card_data = sorted(all_card_data, key=lambda k: k['released_at'], reverse=True)
unique_card_data = list_of_seq_unique_by_key(unique_card_data, 'name')
# unique_card_data=list({v['name']:v for v in all_card_data}.values())
# print(unique_card_data)

with open('/mnt/c/Users/dlshaffer/Downloads/example_deck_data.json', 'w') as standard_cards:
    json.dump(unique_card_data, standard_cards)

mana_costs=list({v['mana_cost']:v for v in unique_card_data})
print(mana_costs)

for cost in mana_costs:
    cost=cost.replace('{', '').replace('}', '')
    symbols=[character if character in ['U', 'W', 'R', 'B', 'G'] else '' for character in cost]
    unique_symbols=list(set([i for i in symbols if i]))

    for symbol in unique_symbols:
        num_generic=0
        gold_card=False
        for val in cost:
            if val.isdigit():
                num_generic+=int(val)
            elif val != symbol:
                num_generic+=1
                gold_card=True

        karston_formatted_cost=(str(num_generic) if num_generic != 0 else '') + 'C' * cost.count(symbol)

        deck_min_requirements[symbol]=max(deck_min_requirements[symbol], frank_recommendation[karston_formatted_cost] if gold_card is False else frank_recommendation[karston_formatted_cost] + 1)


print(deck_min_requirements)

costs_and_sources = []





### Get standard legal cards from overall JSON
# standard_legal_cards=list(filter(lambda card: card['legalities']['standard'] == 'legal', card_data))
#
# with open('/mnt/c/Users/dlshaffer/Downloads/standard_mtg_cards.json', 'w') as standard_cards:
#     json.dump(standard_legal_cards, standard_cards)
