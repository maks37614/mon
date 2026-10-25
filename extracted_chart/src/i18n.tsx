import React,{useLayoutEffect}from'react';
import uk from'../translations/uk.json';
import ru from'../translations/ru.json';
import en from'../translations/en.json';
import pl from'../translations/pl.json';

export type UiLanguage='uk'|'ru'|'en'|'pl';
type Dict=Record<string,string>;
const dictionaries:Record<UiLanguage,Dict>={uk:uk as Dict,ru:ru as Dict,en:en as Dict,pl:pl as Dict};
const phraseKeys:Record<UiLanguage,string[]>=Object.fromEntries((Object.keys(dictionaries) as UiLanguage[]).map(lang=>[lang,Object.keys(dictionaries[lang]).filter(k=>k.length>=5).sort((a,b)=>b.length-a.length)])) as Record<UiLanguage,string[]>;
let activeLanguage:UiLanguage='uk';
const textState=new WeakMap<Text,{source:string,last:string}>();
const attrState=new WeakMap<Element,Map<string,{source:string,last:string}>>();
const ATTRS=['title','aria-label','placeholder','alt'] as const;

export function setUiLanguage(lang:UiLanguage){activeLanguage=lang;document.documentElement.lang=lang}
export function tr(input:string,lang:UiLanguage=activeLanguage){
 const dict=dictionaries[lang]||dictionaries.uk;
 if(dict[input]!=null)return dict[input];
 if(!/[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(input))return input;
 if(/^[A-Z0-9/_:+. \-$%]+$/.test(input)&&input.length<28)return input;
 let out=input;
 // Handles dynamic labels such as "Порог плотностей ≥ $100K" while keeping numbers untouched.
 for(const k of phraseKeys[lang]){if(!out.includes(k))continue;const v=dict[k];if(v!==k)out=out.split(k).join(v)}
 return out;
}
function localizeText(node:Text,lang:UiLanguage){
 const current=node.nodeValue||'';let st=textState.get(node);
 if(!st){st={source:current,last:current};textState.set(node,st)}else if(current!==st.last){st.source=current}
 const next=tr(st.source,lang);st.last=next;if(current!==next)node.nodeValue=next;
}
function localizeElement(el:Element,lang:UiLanguage){
 let map=attrState.get(el);if(!map){map=new Map;attrState.set(el,map)}
 for(const a of ATTRS){if(!el.hasAttribute(a))continue;const current=el.getAttribute(a)||'';let st=map.get(a);if(!st){st={source:current,last:current};map.set(a,st)}else if(current!==st.last){st.source=current}const next=tr(st.source,lang);st.last=next;if(current!==next)el.setAttribute(a,next)}
 for(const n of Array.from(el.childNodes)){if(n.nodeType===Node.TEXT_NODE)localizeText(n as Text,lang);else if(n.nodeType===Node.ELEMENT_NODE)localizeElement(n as Element,lang)}
}
export function localizeDocument(lang:UiLanguage){setUiLanguage(lang);if(document.body)localizeElement(document.body,lang)}
export function LocalizationBridge({language}:{language:UiLanguage}){
 useLayoutEffect(()=>{
  localizeDocument(language);
  const observer=new MutationObserver(mutations=>{for(const m of mutations){if(m.type==='characterData'&&m.target.nodeType===Node.TEXT_NODE)localizeText(m.target as Text,language);if(m.type==='attributes'&&m.target.nodeType===Node.ELEMENT_NODE)localizeElement(m.target as Element,language);for(const n of Array.from(m.addedNodes)){if(n.nodeType===Node.TEXT_NODE)localizeText(n as Text,language);else if(n.nodeType===Node.ELEMENT_NODE)localizeElement(n as Element,language)}}});
  observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:[...ATTRS]});
  return()=>observer.disconnect();
 },[language]);
 return null;
}
