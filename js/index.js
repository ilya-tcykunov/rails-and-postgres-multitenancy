$(function() {
	blobbing();
});

var blobbing = function() {
	$(".checkpoint").hover(function() {
    var $cur = $(this);
    var dest = $cur.position().left - 30;
    var t = 0.9;
    TweenMax.to($(".blob, .radials"),t,{x:dest,ease:Back.easeOut});
  });
};