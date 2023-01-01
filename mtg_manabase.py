from ttkbootstrap import Style
import tkinter as tk
from tkinter import *
import ttkbootstrap as ttk
from ttkbootstrap import widgets
from ttkbootstrap.scrolled import ScrolledFrame

import PIL
from PIL import Image,ImageTk


# class ScrollableFrame(ttk.Frame):
#     def __init__(self, container, *args, **kwargs):
#         super().__init__(container, *args, **kwargs)
#         self.canvas = tk.Canvas(self)
#         scrollbar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
#         self.scrollable_frame = ttk.Frame(self.canvas)
#
#         self.scrollable_frame.bind(
#             "<Configure>",
#             lambda e: self.canvas.configure(
#                 scrollregion=self.canvas.bbox("all")
#             )
#         )
#
#         self.canvas.create_window((0, 0), window=self.scrollable_frame, anchor="nw")
#
#         self.canvas.configure(yscrollcommand=scrollbar.set)
#
#         self.canvas.pack(side="left", fill="both", expand=True)
#         scrollbar.pack(side="right", fill="y")
#
#         self.canvas.bind('<Enter>', self._bound_to_mousewheel)
#         self.canvas.bind('<Leave>', self._unbound_to_mousewheel)
#
#     def _bound_to_mousewheel(self, event):
#         self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)
#         self.canvas.bind_all("<Button-4>", self._scrolling_linux)
#         self.canvas.bind_all("<Button-5>", self._scrolling_linux)
#
#
#     def _unbound_to_mousewheel(self, event):
#         self.canvas.unbind_all("<MouseWheel>")
#
#     def _on_mousewheel(self, event):
#         self.canvas.yview_scroll(int(-1 * (event.delta // 120)), "units")
#
#     def _scrolling_linux(self, event:tk.Event) -> None:
#         y_steps = 1
#         if event.num == 4:
#             y_steps *= -1
#         self.canvas.yview_scroll(y_steps, "units")

class card(tk.Frame):
    def __init__(self, master, card_dict, TotalManaCounts):
        super().__init__(master)

        self.counter=tk.IntVar()
        self.counter.set(0)

        self.frame=Frame(master)
        self.card_dict=card_dict
        self.TotalManaCounts=TotalManaCounts

        self.get_card_image()
        self.cc_card_image = self.cc_card_image.resize((int(self.cc_card_image.size[0] / 3), int(self.cc_card_image.size[1] / 3)), Image.ANTIALIAS)
        self.cc_test = ImageTk.PhotoImage(self.cc_card_image)
        self.cc_image_holder = tk.Label(self.frame, image=self.cc_test)
        self.cc_image_holder.pack()

        self.cc_handler_frame = Frame(self.frame)
        self.cc_handler_frame.place(bordermode=INSIDE, anchor=NE, relx=.9, rely=.02)
        self.cc_minus_button = Button(self.cc_handler_frame, text='-1', command=lambda : self.change_count(-1))
        self.cc_minus_button.grid(row=0, column=0)
        self.cc_num_cards = Label(self.cc_handler_frame, textvariable=self.counter)
        self.cc_num_cards.grid(row=0, column=1)
        self.cc_plus_button = Button(self.cc_handler_frame, text='+1', command=lambda : self.change_count(1))
        self.cc_plus_button.grid(row=0, column=2)

    def change_count(self, change):
        if not 0 <= self.counter.get() + change <= 4:
            return

        self.counter.set(self.counter.get() + change)
        if 'W' in self.card_dict.get('produced_mana'):
            self.TotalManaCounts['white']['count'].set(self.TotalManaCounts['white']['count'].get()+change)
        if 'U' in self.card_dict.get('produced_mana'):
            self.TotalManaCounts['blue']['count'].set(self.TotalManaCounts['blue']['count'].get()+change)
        if 'B' in self.card_dict.get('produced_mana'):
            self.TotalManaCounts['black']['count'].set(self.TotalManaCounts['black']['count'].get()+change)
        if 'R' in self.card_dict.get('produced_mana'):
            self.TotalManaCounts['red']['count'].set(self.TotalManaCounts['red']['count'].get()+change)
        if 'G' in self.card_dict.get('produced_mana'):
            self.TotalManaCounts['green']['count'].set(self.TotalManaCounts['green']['count'].get()+change)

        self.TotalManaCounts['total']['count'].set(self.TotalManaCounts['total']['count'].get()+change)

    def get_card_image(self):
        import os
        import requests
        import shutil
        filename=f"mtg_manabase_pngs/{self.card_dict['set']}-{self.card_dict['collector_number']}-{self.card_dict['name'].lower().replace(' ', '-')}.png"
        # print(f"Looking for: {filename}")
        # print(self.card_dict['image_uris']['png'])
        if not os.path.isfile(filename):
            print(f"Downloading: {filename}")
            r = requests.get(self.card_dict['image_uris']['png'])
            with open(filename, 'wb') as outfile:
                outfile.write(r.content)

        self.cc_card_image = Image.open(filename)



    def print_contents(self):
        print("Hi. The current entry content is:",
              self.counter.get())

    def print_contents_event(self, event):
        print("Hi. The current entry content is:",
              self.counter.get())


def list_of_seq_unique_by_key(seq, key):
    seen = set()
    seen_add = seen.add
    return [x for x in seq if x[key] not in seen and not seen_add(x[key])]

root = tk.Tk()
style = ttk.Style("darkly")
root.geometry('1600x900')

TotalManaCounts = {'white': {'count' : tk.IntVar()},
                   'blue': {'count' : tk.IntVar()},
                   'black': {'count' : tk.IntVar()},
                   'red': {'count' : tk.IntVar()},
                   'green': {'count' : tk.IntVar()},
                   'total': {'count' : tk.IntVar()}}

show_just_rares=False

mana_counts_frame=Frame(root)
mana_counts_frame.pack(side=RIGHT)
card_images_frame = ScrolledFrame(root, autohide=True)
card_images_frame.pack(fill='both', expand=True)

mana_symbols=['plains', 'island', 'swamp', 'mountain', 'forest']
mana_labels=[]
card_image={}
test={}
image_holder={}
for index, mana in enumerate(mana_symbols):
    print(index)
    card_image[index] = Image.open(f'mtg_manabase_pngs/{mana}.png')
    card_image[index] = card_image[index].resize((100, 100), Image.ANTIALIAS)
    test[index] = ImageTk.PhotoImage(card_image[index])
    image_holder[index] = tk.Label(mana_counts_frame, image=test[index])
    image_holder[index].grid(row=index, column=0, pady=10)

total_label= Label(mana_counts_frame, text='Total = ', font=('Arial', 36))
total_label.grid(row=5, column=0)

for index, name in enumerate(TotalManaCounts):
    TotalManaCounts[name]['count'].set(0)
    TotalManaCounts[name]['label']=Label(mana_counts_frame, textvariable=TotalManaCounts[name]['count'], bg='AntiqueWhite4', font=('Arial', 48))
    TotalManaCounts[name]['label'].grid(row=index, column=1)


import json
with open('standard_mtg_cards.json', 'r') as card_file:
    card_data = json.load(card_file)
    
standard_lands=list(filter(lambda card: card['type_line'] in ('Land', 'Legendary Land') or 'Basic Land' in card['type_line'] , card_data))
# standard_lands=list(filter(lambda card: card['booster'] == True, standard_lands))
# unique_lands = sorted(standard_lands, key=lambda k: k['released_at'], reverse=True)
unique_lands = sorted(standard_lands, key=lambda k: (
    k.get('type_line'),
    k.get('oracle_text').replace(k.get('name'), ''),
    'arena' in k.get('games'),
    k.get('highres_image') == True,
    k.get('border_color', 'None')[0] == 'borderless',
    k.get('frame_effects', 'None')[0] != 'inverted',
    k.get('frame_effects', 'None')[0] == 'extendedart',
    k.get('full_art', 'None') == True,
    k['released_at']), reverse=True)
unique_lands = list_of_seq_unique_by_key(unique_lands, 'name')


with open('lands_data.json', 'w') as lands_file:
    json.dump(unique_lands, lands_file)


all_labels=[card(card_images_frame, land, TotalManaCounts) for land in unique_lands]
for index, label in enumerate(all_labels):
    label.frame.grid(row=index//5, column=index%5)


def toggle():
    for x in all_labels:
        x.frame.grid_remove()
    if toggle_btn.config('relief')[-1] == 'sunken':
        toggle_btn.config(relief="raised")
        rarities=('rare', 'mythic', 'common', 'uncommon')
    else:
        toggle_btn.config(relief="sunken")
        rarities = ('rare', 'mythic')

    for index, label in enumerate(filter(lambda card: card.card_dict['rarity'] in rarities , all_labels)):
        label.frame.grid(row=index // 5, column=index % 5)

toggle_btn = tk.Button(mana_counts_frame, text="Show Only Rares", width=12, relief="raised", command=toggle)
toggle_btn.grid(row=7,column=0)

root.mainloop()