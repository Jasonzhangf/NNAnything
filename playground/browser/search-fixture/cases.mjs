// Original synthetic content. Source observations are documented, never copied here.
const field=(role,text,extra={})=>({role,text,...extra});
const item=(key,fields,children=[])=>({key,fields,children});
const layout=(extra={})=>({columns:1,maxWidth:1120,cardBorder:true,fieldOrder:['title','author','time','body','image','video','source','citation','metric'],wrapperDepth:0,...extra});
export const scenarios=['normal','delayed','empty','error','blocked','ineffective'];
export const profiles=[
  {
    id:'stream',label:'社交流与旁栏',layout:layout(),input:{tag:'input',type:'text'},
    groups:[
      {label:'动态',placement:'main',items:[
        item('stream-body',[field('author','山间记录员'),field('time','今天 09:20'),field('body','第一次露营，先检查天气和营地规定。背包里放饮水、头灯和雨衣，离开时带走全部垃圾。'),field('image','营地和帐篷示意图'),field('metric','评论 8 · 喜欢 21')]),
        item('stream-quote',[field('author','周末观察者'),field('body','分享一段城市散步路线，顺便记录沿途的树荫和休息点。')],[item('quoted-author',[field('author','路线分享者'),field('body','从河岸步道经过旧街区，到公园休息。')])]),
        item('stream-video',[field('author','轻装出发'),field('body','露营收纳步骤'),field('video','收纳演示的合成视频封面'),field('metric','评论 3')]),
      ]},
      {label:'相关用户',placement:'aside',items:[
        item('person-one',[field('title','露营手记'),field('body','记录户外装备与营地观察。')]),
        item('person-two',[field('title','城市步行者'),field('body','分享街区漫步路线。')]),
        item('person-three',[field('title','天气记录站'),field('body','户外天气资料。')]),
      ]},
    ],
  },
  {
    id:'columns',label:'媒体瀑布与可选标题',layout:layout({columns:3,maxWidth:1240,fieldOrder:['image','video','title','author','metric','body'],wrapperDepth:1}),input:{tag:'textarea',type:'text'},
    groups:[{label:'笔记',placement:'main',items:[
      item('media-one',[field('image','帐篷搭建示意图',{ratio:0.8}),field('title','露营装备的轻量清单'),field('author','户外笔记本'),field('metric','喜欢 62')]),
      item('media-two',[field('video','城市散步封面',{ratio:1.4}),field('title','慢慢走过一条老街'),field('author','小路记录'),field('metric','喜欢 17')]),
      item('media-untitled',[field('image','无独立标题的营地照片',{ratio:0.65}),field('author','沿途留影'),field('metric','喜欢 9')]),
      item('media-last',[field('image','雨后步道示意图',{ratio:1.2}),field('title','雨后路线观察'),field('author','自然观察员')]),
    ]}],
  },
  {
    id:'discussion',label:'问题与回答摘要',layout:layout({maxWidth:940,wrapperDepth:2}),input:{tag:'input',type:'text'},
    groups:[{label:'讨论',placement:'main',items:[
      item('question-one',[field('title','第一次露营需要准备什么？'),field('author','回答者甲'),field('body','可以先按睡眠、饮水、照明和天气防护分组准备。每件装备都应有明确用途；出发前了解营地规则，再按真实行程删去不必要的物品。不要只根据某一份清单决定全部装备，也需要检查季节、地形和交通条件。'),field('metric','赞同 35 · 回答 12')]),
      item('question-two',[field('title','怎样规划一条城市散步路线？'),field('author','回答者乙'),field('body','先确认起点、终点、可步行道路和休息点。'),field('metric','赞同 18')]),
      item('question-three',[field('title','户外活动遇到天气变化怎么办？'),field('author','回答者丙'),field('body','按实际天气与场地条件判断是否中止。'),field('metric','回答 7')]),
    ]}],
  },
  {
    id:'documents',label:'图片组与网页摘要',layout:layout({maxWidth:1060,cardBorder:false,fieldOrder:['source','title','time','body','citation','image'],wrapperDepth:1}),input:{tag:'textarea',type:'text'},
    groups:[
      {label:'图片',placement:'main',items:[
        item('picture-one',[field('image','Camping checklist illustrated',{ratio:1.7}),field('source','Outdoor field notes')]),
        item('picture-two',[field('image','Walk route map illustration',{ratio:1.4}),field('source','Neighborhood archive')]),
        item('picture-three',[field('image','Packing diagram',{ratio:1.9}),field('source','Open guide')]),
      ]},
      {label:'网页',placement:'main',items:[
        item('document-one',[field('source','Field Guide · Outdoors'),field('title','Camping essentials checklist'),field('time','Updated October'),field('body','A practical checklist for shelter, water and light.'),field('citation','Packing checklist'),field('citation','Weather preparation')]),
        item('document-two',[field('source','Neighborhood Guide'),field('title','Plan a walk through the city'),field('body','Choose a route with safe crossings and rest stops.')]),
        item('document-three',[field('source','Open Handbook'),field('title','Leave the campsite clean'),field('body','A guide to collecting waste and leaving shared spaces ready for others.')]),
      ]},
    ],
  },
  {
    id:'synthesis',label:'回答、引用与网页混合',layout:layout({maxWidth:1100,fieldOrder:['title','body','citation','source','image','metric'],wrapperDepth:2}),input:{tag:'input',type:'search'},
    groups:[
      {label:'参考回答',placement:'main',items:[
        item('answer-one',[field('title','露营准备要点'),field('body','可按住宿、饮水、照明和天气防护检查装备。以下资料给出准备步骤与场地注意事项。'),field('citation','来源一：营地准备指南'),field('citation','来源二：步道安全手册')]),
        item('answer-two',[field('title','行程检查'),field('body','确认天气、交通与营地规则。')]),
        item('answer-three',[field('title','返程检查'),field('body','检查人员、装备和垃圾带离情况。')]),
      ]},
      {label:'网页',placement:'main',items:[
        item('answer-web-one',[field('source','户外基础手册'),field('title','露营装备检查表'),field('body','按行程核对基本装备。')]),
        item('answer-web-two',[field('source','城市路线档案'),field('title','周末步行路线'),field('body','一份街区步行路线说明。')]),
        item('answer-web-three',[field('source','自然观察档案'),field('title','天气与场地'),field('body','理解户外条件与活动限制。')]),
      ]},
    ],
  },
];

// Added after the renderer was complete. Representation compatibility only,
// not a new implementation family or an independent model evaluation set.
profiles.push({
  id:'compact',label:'新增紧凑表示',
  layout:{columns:1,maxWidth:760,cardBorder:false,fieldOrder:['author','source','title','metric','body','time','citation','image','video'],wrapperDepth:3},
  input:{tag:'input',type:'search'},
  groups:[{label:'资料目录',placement:'main',items:[
    item('compact-a',[field('author','路线记录组'),field('title','城市散步路线记录'),field('metric','记录 6 条'),field('body','沿河岸、街区和公园组织路线。')]),
    item('compact-b',[field('source','装备资料组'),field('title','露营装备记录'),field('metric','记录 12 条'),field('body','按睡眠、饮水和照明整理资料。')]),
    item('compact-c',[field('author','天气记录组'),field('title','天气变化记录'),field('metric','记录 3 条')]),
  ]}],
});
